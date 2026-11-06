import type { SeoPageMarkedValues, SeoPageMarkupItem } from "./facts";
import type { DefaultTreeAdapterTypes } from "parse5";

import { jsonLdText } from "./audit-schema";
import { SEO_MARKUP_LIMITS } from "./reading-limits";
import { schemaLocalName } from "./schema-validate";
import { isJsonObject, parseBoundedJson, spend, walkBudget } from "./structured-json";
import type { WalkBudget } from "./structured-json";

/**
 * THE STRUCTURED DATA READ beyond JSON-LD: the microdata (`itemscope`, `itemtype`, `itemprop`) and
 * RDFa (`vocab`, `typeof`, `property`) items of a page's schema.org markup, read into the same shape
 * a JSON-LD item has, so one validator judges all three; and, for every price and rating the markup
 * states (in any of the three syntaxes), whether the page's visible text shows it. Read from the page
 * as stored (the rendered DOM whenever the browser rendered it), so markup a script adds counts. Pure.
 *
 * BOUNDED: the page is untrusted, and every bound is a TOTAL for the page, counted BEFORE anything is
 * allocated. One walk reads microdata and RDFa together and spends one count of the elements it
 * visits; items nest only so deep; every text value, every item and every property is charged to one
 * page allowance of characters before it is kept, an item held under several names charged once per
 * name (so a page cannot multiply one item into an exponential tree); an attribute gives only so many
 * names; and the JSON-LD blocks read for prices are measured, one by one and together, before they are
 * joined or parsed ({@link SEO_MARKUP_LIMITS}). Past a bound the read keeps what it has and says it
 * was cut short (`truncated`), never failing the page.
 */

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** A JSON object. */
type JsonObject = Record<string, unknown>;

/** The HTML namespace. */
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Elements whose text is never shown. */
const HIDDEN_TEXT = new Set(["script", "style", "noscript", "template", "head", "title"]);

/** How deep the element walk goes. */
const MAX_DEPTH = 300;

/** How deep the JSON walk for prices and ratings goes. */
const MAX_VALUE_DEPTH = 12;

/** Names one `itemprop`, `itemtype`, `property` or `typeof` attribute gives at most. */
const MAX_ATTRIBUTE_NAMES = 16;

/** Characters of such an attribute read for its names. */
const MAX_ATTRIBUTE_CHARS = 1_000;

/** Characters a value's or an item's key and punctuation add to the JSON, charged with it. */
const ENTRY_OVERHEAD = 8;

/** Values of one property (offers, prices, ratings) the price and rating read takes. */
const MAX_LIST_VALUES = 50;

/** Characters of a marked-up number read. */
const MAX_NUMBER_CHARS = 64;

/** Attributes whose words a visitor sees or hears (star ratings are often only labelled). */
const SHOWN_ATTRIBUTES = ["aria-label", "title", "alt"] as const;

/** A number as pages write it, grouping separators and decimal marks included. */
const NUMBER_TOKEN = /\d(?:[\d.,'\u00A0\u202F ]*\d)?/g;

/** The context a microdata or RDFa item is written out with. */
const SCHEMA_CONTEXT = "https://schema.org";

/** Whether a URL names schema.org. */
const SCHEMA_VOCAB = /^https?:\/\/(?:www\.)?schema\.org\/?$/i;

/** One page's microdata and RDFa read: its top-level items and what it may still spend. */
interface Reading {
	microdata: JsonObject[];
	rdfa: JsonObject[];
	/** Elements the walk may still visit. */
	elements: number;
	/** Characters of JSON the read may still take, values, items and properties alike. */
	chars: number;
	/** What each item would weigh written out as JSON (every name it is held under included). */
	weights: WeakMap<JsonObject, number>;
	/** Whether a bound cut the read short. */
	truncated: boolean;
}

/** Where one syntax's read stands at an element. */
interface Scope {
	/** The item being filled, or null outside one. */
	current: JsonObject | null;
	/** How many items enclose the element. */
	itemDepth: number;
	/** Whether a bound turned this syntax's read off below the element. */
	off: boolean;
	/** Whether bare names are schema.org (RDFa under a schema.org `vocab`). */
	vocab: boolean;
}

/** What one syntax made of an element: the scope its children are read in, and an item it opened. */
interface Step {
	inner: Scope;
	/** The item the element opened, the names it is held under in the enclosing item, and whether it
	 * stands on its own when no enclosing item holds it. */
	item: JsonObject | null;
	names: string[];
	top: boolean;
}

/**
 * A fresh read within the bounds.
 *
 * @returns The read.
 */
function newReading(): Reading {
	return {
		microdata: [],
		rdfa: [],
		elements: SEO_MARKUP_LIMITS.structuredElements,
		chars: SEO_MARKUP_LIMITS.structuredReadChars,
		weights: new WeakMap(),
		truncated: false
	};
}

/**
 * Takes one element visit from a read.
 *
 * @param into - The read.
 * @returns Whether a visit was left.
 */
function visit(into: Reading): boolean {
	if (into.elements <= 0) {
		into.truncated = true;
		return false;
	}
	into.elements -= 1;
	return true;
}

/**
 * Takes characters from a read's allowance before what they pay for is kept. Once the allowance cannot
 * pay, the read stops.
 *
 * @param into - The read.
 * @param cost - The characters.
 * @returns Whether they were left.
 */
function charge(into: Reading, cost: number): boolean {
	if (cost > into.chars) {
		into.chars = 0;
		into.truncated = true;
		return false;
	}
	into.chars -= cost;
	return true;
}

/**
 * An element's attribute.
 *
 * @param element - The element.
 * @param name - The attribute's name.
 * @returns Its value, or undefined.
 */
function attr(element: Element, name: string): string | undefined {
	return element.attrs.find((entry) => entry.name === name)?.value;
}

/**
 * An attribute value cut to what one text value may keep, before it is trimmed or resolved.
 *
 * @param value - The value as written.
 * @returns Its start.
 */
function clipped(value: string): string {
	const max = SEO_MARKUP_LIMITS.structuredValueChars * 2;
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * The child elements of a node.
 *
 * @param node - The node.
 * @returns Its element children.
 */
function childElements(node: Node): Element[] {
	if (!("childNodes" in node)) return [];
	return node.childNodes.filter(
		(child): child is Element => "tagName" in child && child.namespaceURI === HTML_NS
	);
}

/**
 * An element's text, whitespace collapsed, cut at a value's bound.
 *
 * @param node - The element.
 * @param into - The read, whose element visits it spends.
 * @returns Its text.
 */
function textOf(node: Node, into: Reading): string {
	const max = SEO_MARKUP_LIMITS.structuredValueChars;
	const parts: string[] = [];
	let length = 0;
	const stack: Node[] = [node];
	while (stack.length > 0 && length < max) {
		const next = stack.pop();
		if (next === undefined || !visit(into)) break;
		if (next.nodeName === "#text" && "value" in next) {
			const text = next.value.slice(0, max * 2 - length);
			parts.push(text);
			length += text.length;
			continue;
		}
		if ("tagName" in next && HIDDEN_TEXT.has(next.tagName) && next !== node) continue;
		if ("childNodes" in next) {
			for (let index = next.childNodes.length - 1; index >= 0; index -= 1) {
				const child = next.childNodes[index];
				if (child !== undefined) stack.push(child);
			}
		}
	}
	return parts.join("").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * A URL resolved against the page.
 *
 * @param value - The value as written.
 * @param base - The page's base URL.
 * @returns The absolute URL, or the value as written when it cannot be resolved.
 */
function resolved(value: string, base: string): string {
	const text = clipped(value).trim();
	try {
		return new URL(text, base).href;
	} catch {
		return text;
	}
}

/**
 * The value an element gives its microdata property (the HTML standard's rules) or its RDFa property
 * (`content` first, then the link it names, then its text).
 *
 * @param element - The element.
 * @param base - The page's base URL.
 * @param rdfa - Whether the property is RDFa.
 * @param into - The read.
 * @returns The value, cut short.
 */
function propertyValue(element: Element, base: string, rdfa: boolean, into: Reading): string {
	return rawPropertyValue(element, base, rdfa, into).slice(
		0,
		SEO_MARKUP_LIMITS.structuredValueChars
	);
}

/**
 * The value an element gives its property, as written (its start, when it is long).
 *
 * @param element - The element.
 * @param base - The page's base URL.
 * @param rdfa - Whether the property is RDFa.
 * @param into - The read.
 * @returns The value.
 */
function rawPropertyValue(element: Element, base: string, rdfa: boolean, into: Reading): string {
	const content = attr(element, "content");
	if (content !== undefined && (rdfa || element.tagName === "meta")) return clipped(content).trim();
	switch (element.tagName) {
		case "audio":
		case "embed":
		case "iframe":
		case "img":
		case "source":
		case "track":
		case "video": {
			const src = attr(element, "src");
			if (src !== undefined) return resolved(src, base);
			break;
		}
		case "a":
		case "area":
		case "link": {
			const href = attr(element, rdfa ? "resource" : "href") ?? attr(element, "href");
			if (href !== undefined) return resolved(href, base);
			break;
		}
		case "object": {
			const data = attr(element, "data");
			if (data !== undefined) return resolved(data, base);
			break;
		}
		case "data":
		case "meter": {
			const value = attr(element, "value");
			if (value !== undefined) return clipped(value).trim();
			break;
		}
		case "time": {
			const datetime = attr(element, "datetime");
			if (datetime !== undefined) return clipped(datetime).trim();
			break;
		}
		default:
			break;
	}
	if (rdfa) {
		const resource = attr(element, "resource");
		if (resource !== undefined) return resolved(resource, base);
	}
	return textOf(element, into);
}

/**
 * The weight of a value written out as JSON.
 *
 * @param into - The read.
 * @param value - A text value or an item.
 * @returns Its characters.
 */
function weightOf(into: Reading, value: string | JsonObject): number {
	return typeof value === "string" ? value.length : (into.weights.get(value) ?? 0);
}

/**
 * Adds a value to an item's property under each of its names, a second value turning it into a list.
 * Each name is paid for before it is added: a text value its characters, an item its whole weight (its
 * first holder already paid for it as it was read, so only the further copies cost more).
 *
 * @param into - The read.
 * @param item - The item.
 * @param names - The property's names.
 * @param value - The value.
 */
function addProperty(
	into: Reading,
	item: JsonObject,
	names: readonly string[],
	value: string | JsonObject
): void {
	const weight = weightOf(into, value);
	const paid = typeof value === "string" ? 0 : weight;
	for (const [index, name] of names.entries()) {
		const added = weight + name.length + ENTRY_OVERHEAD;
		const cost = index === 0 ? added - paid : added;
		if (!charge(into, cost)) return;
		into.weights.set(item, weightOf(into, item) + added);
		const held = item[name];
		if (held === undefined) item[name] = value;
		else if (Array.isArray(held)) held.push(value);
		else item[name] = [held, value];
	}
}

/**
 * A new item, paid for before it is made.
 *
 * @param into - The read.
 * @param types - Its types.
 * @param id - Its id as written, or undefined.
 * @param base - The page's base URL.
 * @returns The item, or null when the allowance cannot pay for it.
 */
function newItem(
	into: Reading,
	types: readonly string[],
	id: string | undefined,
	base: string
): JsonObject | null {
	const at = id === undefined ? undefined : resolved(id, base);
	const cost =
		ENTRY_OVERHEAD +
		types.reduce((sum, type) => sum + type.length + ENTRY_OVERHEAD, 0) +
		(at === undefined ? 0 : at.length + ENTRY_OVERHEAD);
	if (!charge(into, cost)) return null;
	const item: JsonObject = {};
	if (types.length > 0) item["@type"] = types.length === 1 ? types[0] : [...types];
	if (at !== undefined) item["@id"] = at;
	into.weights.set(item, cost);
	return item;
}

/**
 * The schema.org names of an `itemtype`, `typeof`, `itemprop` or `property`, others left out, at most
 * {@link MAX_ATTRIBUTE_NAMES} read from the attribute's first {@link MAX_ATTRIBUTE_CHARS} characters.
 *
 * @param value - The attribute, or undefined.
 * @param vocab - Whether bare names are schema.org (microdata properties in an item, RDFa under a
 *   schema.org `vocab`).
 * @returns The names.
 */
function namesIn(value: string | undefined, vocab: boolean): string[] {
	if (value === undefined) return [];
	const names: string[] = [];
	for (const word of value.slice(0, MAX_ATTRIBUTE_CHARS).split(/\s+/)) {
		if (names.length >= MAX_ATTRIBUTE_NAMES) break;
		if (word === "") continue;
		const name = vocab || /[:/]/.test(word) ? schemaLocalName(word) : null;
		if (name !== null && name !== "") names.push(name);
	}
	return names;
}

/** A syntax's read turned off below an element. */
const OFF: Scope = { current: null, itemDepth: 0, off: true, vocab: false };

/**
 * A step that opens nothing.
 *
 * @param inner - The scope the children are read in.
 * @returns The step.
 */
function passOn(inner: Scope): Step {
	return { inner, item: null, names: [], top: false };
}

/**
 * What the microdata read makes of one element.
 *
 * @param element - The element.
 * @param base - The page's base URL.
 * @param scope - Where the read stands.
 * @param into - The read.
 * @returns The step.
 */
function microdataStep(element: Element, base: string, scope: Scope, into: Reading): Step {
	if (scope.off) return passOn(scope);
	const opens = attr(element, "itemscope") !== undefined;
	if (opens && scope.itemDepth >= SEO_MARKUP_LIMITS.structuredDepth) {
		into.truncated = true;
		return passOn(OFF);
	}
	const names = scope.current === null ? [] : namesIn(attr(element, "itemprop"), true);
	if (opens) {
		const types = namesIn(attr(element, "itemtype"), false);
		const item = newItem(into, types, attr(element, "itemid"), base);
		if (item === null) return passOn(OFF);
		const inner: Scope = { current: item, itemDepth: scope.itemDepth + 1, off: false, vocab: true };
		return { inner, item, names, top: types.length > 0 };
	}
	if (scope.current !== null && names.length > 0)
		addProperty(into, scope.current, names, propertyValue(element, base, false, into));
	return passOn(scope);
}

/**
 * What the RDFa read (schema.org) makes of one element.
 *
 * @param element - The element.
 * @param base - The page's base URL.
 * @param scope - Where the read stands.
 * @param into - The read.
 * @returns The step.
 */
function rdfaStep(element: Element, base: string, scope: Scope, into: Reading): Step {
	if (scope.off) return passOn(scope);
	const vocabAttr = attr(element, "vocab");
	const vocab =
		vocabAttr === undefined ? scope.vocab : SCHEMA_VOCAB.test(clipped(vocabAttr).trim());
	const here: Scope = { ...scope, vocab };
	const typeOfAttr = attr(element, "typeof");
	const names = scope.current === null ? [] : namesIn(attr(element, "property"), vocab);
	if (typeOfAttr !== undefined) {
		const types = namesIn(typeOfAttr, vocab);
		if (types.length === 0) return passOn(here);
		if (scope.itemDepth >= SEO_MARKUP_LIMITS.structuredDepth) {
			into.truncated = true;
			return passOn(OFF);
		}
		const item = newItem(into, types, attr(element, "resource") ?? attr(element, "about"), base);
		if (item === null) return passOn(OFF);
		const inner: Scope = { current: item, itemDepth: scope.itemDepth + 1, off: false, vocab };
		return { inner, item, names, top: true };
	}
	if (scope.current !== null && names.length > 0)
		addProperty(into, scope.current, names, propertyValue(element, base, true, into));
	return passOn(here);
}

/**
 * Places the item an element opened once its children are read: under the enclosing item's property,
 * or on its own.
 *
 * @param step - The element's step.
 * @param outer - The scope the element was read in.
 * @param list - The syntax's top-level items.
 * @param into - The read.
 */
function settle(step: Step, outer: Scope, list: JsonObject[], into: Reading): void {
	if (step.item === null) return;
	if (outer.current !== null && step.names.length > 0)
		addProperty(into, outer.current, step.names, step.item);
	else if (step.top) {
		const item: JsonObject = { "@context": SCHEMA_CONTEXT, ...step.item };
		into.weights.set(item, weightOf(into, step.item) + SCHEMA_CONTEXT.length + ENTRY_OVERHEAD);
		list.push(item);
	}
}

/**
 * Reads the microdata and RDFa items under a node in one walk.
 *
 * @param node - The node.
 * @param base - The page's base URL.
 * @param microdata - Where the microdata read stands.
 * @param rdfa - Where the RDFa read stands.
 * @param into - The read.
 * @param depth - How deep the walk is.
 */
function readItems(
	node: Node,
	base: string,
	microdata: Scope,
	rdfa: Scope,
	into: Reading,
	depth: number
): void {
	if (depth > MAX_DEPTH) {
		into.truncated = true;
		return;
	}
	for (const element of childElements(node)) {
		if (into.chars <= 0 || !visit(into)) return;
		const md = microdataStep(element, base, microdata, into);
		const rd = rdfaStep(element, base, rdfa, into);
		if (!md.inner.off || !rd.inner.off)
			readItems(element, base, md.inner, rd.inner, into, depth + 1);
		settle(md, microdata, into.microdata, into);
		settle(rd, rdfa, into.rdfa, into);
	}
}

/**
 * The numbers a text shows, as two-decimal strings, read both ways a page may write them (`1,299.00`
 * and `1.299,00`), plus each number's digits alone (`19<sup>99</sup>` reads `1999`).
 *
 * @param text - The text.
 * @returns The numbers.
 */
export function numbersShown(text: string): Set<string> {
	const found = new Set<string>();
	for (const match of text.matchAll(NUMBER_TOKEN)) {
		const token = match[0];
		const parts = [token, ...token.split(/\s+/)];
		for (const part of parts) {
			const compact = part.replace(/[\s']/g, "");
			if (compact === "") continue;
			found.add(`d:${compact.replace(/\D/g, "")}`);
			for (const candidate of [
				compact.replace(/,/g, ""),
				compact.replace(/\./g, "").replace(",", ".")
			]) {
				const value = Number.parseFloat(candidate);
				if (Number.isFinite(value)) found.add(value.toFixed(2));
			}
		}
	}
	return found;
}

/**
 * A marked-up number as a two-decimal string, or null when it is not a positive number.
 *
 * @param value - The value as the markup states it.
 * @returns The number.
 */
function markedNumber(value: unknown): string | null {
	const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
	const match = /\d[\d,]*(?:\.\d+)?/.exec(text.slice(0, MAX_NUMBER_CHARS).replace(/\s/g, ""));
	if (match === null) return null;
	const parsed = Number.parseFloat(match[0].replace(/,/g, ""));
	return Number.isFinite(parsed) && parsed > 0 ? parsed.toFixed(2) : null;
}

/**
 * Whether the page shows a number: the number itself, or its digits run together.
 *
 * @param value - The number, two decimals.
 * @param shownNumbers - What the page shows ({@link numbersShown}).
 * @returns Whether it does.
 */
function shows(value: string, shownNumbers: ReadonlySet<string>): boolean {
	if (shownNumbers.has(value)) return true;
	return value.endsWith(".00")
		? shownNumbers.has(`d:${value.slice(0, -3)}`)
		: shownNumbers.has(`d:${value.replace(".", "")}`);
}

/**
 * The values of a property, a list or one, at most {@link MAX_LIST_VALUES}.
 *
 * @param value - The property's value.
 * @returns The values.
 */
function listOf(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.slice(0, MAX_LIST_VALUES);
	return value === undefined ? [] : [value];
}

/**
 * The first type an item names.
 *
 * @param item - The item.
 * @returns Its type, or empty.
 */
function typeOf(item: JsonObject): string {
	const raw = listOf(item["@type"]).find((entry) => typeof entry === "string");
	return typeof raw === "string" ? (schemaLocalName(raw) ?? raw) : "";
}

/**
 * The prices and ratings the items state, each with whether the page shows it. A product sold in
 * variants states no price here ({@link hasVariants}).
 *
 * @param items - The structured data items, every syntax.
 * @param shownNumbers - What the page shows.
 * @param budget - The values the walk may visit (a fresh page budget when omitted).
 * @returns The marked values.
 */
export function markedValuesOf(
	items: readonly unknown[],
	shownNumbers: ReadonlySet<string>,
	budget: WalkBudget = walkBudget()
): SeoPageMarkedValues[] {
	const found: SeoPageMarkedValues[] = [];
	const add = (type: string, property: SeoPageMarkedValues["property"], raw: unknown[]): void => {
		if (found.length >= SEO_MARKUP_LIMITS.markedValues) return;
		const values = [
			...new Set(
				raw
					.slice(0, MAX_LIST_VALUES)
					.map(markedNumber)
					.filter((v): v is string => v !== null)
			)
		];
		if (values.length === 0) return;
		const visible = values.some((value) => {
			if (shows(value, shownNumbers)) return true;
			return property === "rating" && shownNumbers.has(`${Number.parseFloat(value).toFixed(1)}0`);
		});
		found.push({
			type: type.slice(0, SEO_MARKUP_LIMITS.idChars),
			property,
			values: values.slice(0, SEO_MARKUP_LIMITS.examples),
			visible
		});
	};
	const walk = (value: unknown, depth: number, inVariants: boolean): void => {
		if (depth > MAX_VALUE_DEPTH || !spend(budget)) return;
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (budget.exhausted) return;
				walk(entry, depth + 1, inVariants);
			}
			return;
		}
		if (!isJsonObject(value)) return;
		const offers = listOf(value.offers).filter(isJsonObject);
		const variants = inVariants || hasVariants(value, offers);
		if (offers.length > 0 && !variants) {
			const prices = offers.flatMap((offer) => [
				...listOf(offer.price),
				...listOf(offer.lowPrice),
				...listOf(offer.priceSpecification)
					.filter(isJsonObject)
					.flatMap((spec) => listOf(spec.price))
			]);
			add(typeOf(value), "price", prices);
		}
		const rating = listOf(value.aggregateRating).find(isJsonObject);
		const ownRating = typeOf(value) === "AggregateRating" ? value : null;
		const ratingItem = rating ?? ownRating;
		if (ratingItem !== null && ratingItem !== undefined) {
			add(typeOf(ownRating === null ? value : ratingItem), "rating", [
				...listOf(ratingItem.ratingValue),
				...listOf(ratingItem.ratingCount),
				...listOf(ratingItem.reviewCount)
			]);
		}
		for (const [key, entry] of Object.entries(value)) {
			if (budget.exhausted) return;
			if (key === "offers" || key === "aggregateRating") continue;
			if (key.startsWith("@") && key !== "@graph") continue;
			if (typeof entry === "object") walk(entry, depth + 1, variants);
		}
	};
	for (const item of items) {
		if (budget.exhausted) break;
		walk(item, 0, false);
	}
	return found;
}

/**
 * Whether an item is a product sold in variants (sizes, colours) whose own price the page shows only
 * once a visitor picks one: a product group or an item naming its variants (`hasVariant`,
 * `variesBy`), a variant of one (`isVariantOf`), or offers at more than one price (several offers, or
 * an aggregate offer whose low and high prices differ). Its prices are never compared with the page,
 * nor those of the items under it (the owner, 2026-10-07).
 *
 * @param item - The item.
 * @param offers - Its offers.
 * @returns Whether it is sold in variants.
 */
function hasVariants(item: JsonObject, offers: readonly JsonObject[]): boolean {
	if (typeOf(item) === "ProductGroup") return true;
	if (item.hasVariant !== undefined || item.variesBy !== undefined) return true;
	if (item.isVariantOf !== undefined) return true;
	const prices = new Set<string>();
	for (const offer of offers) {
		for (const field of [offer.price, offer.lowPrice, offer.highPrice]) {
			for (const raw of listOf(field)) {
				const price = markedNumber(raw);
				if (price !== null) prices.add(price);
			}
		}
	}
	return prices.size > 1;
}

/**
 * Every number the page shows: its text outside scripts and styles, and the labels a visitor reads
 * or hears (`aria-label`, `title`, `alt`).
 *
 * @param root - The document.
 * @returns The numbers ({@link numbersShown}).
 */
function pageNumbers(root: Node): Set<string> {
	const spaced: string[] = [];
	const joined: string[] = [];
	let left = SEO_MARKUP_LIMITS.shownTextChars;
	const stack: Node[] = [root];
	while (stack.length > 0 && left > 0) {
		const node = stack.pop();
		if (node === undefined) break;
		if (node.nodeName === "#text" && "value" in node) {
			const text = node.value.slice(0, left);
			left -= text.length;
			spaced.push(text);
			joined.push(text);
			continue;
		}
		if ("tagName" in node) {
			if (HIDDEN_TEXT.has(node.tagName)) continue;
			for (const name of SHOWN_ATTRIBUTES) {
				const value = attr(node, name)?.slice(0, SEO_MARKUP_LIMITS.structuredValueChars);
				if (value !== undefined) {
					left -= value.length;
					spaced.push(` ${value} `);
				}
			}
			spaced.push(" ");
		}
		if ("childNodes" in node) {
			for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
				const child = node.childNodes[index];
				if (child !== undefined) stack.push(child);
			}
		}
	}
	const numbers = numbersShown(spaced.join(" "));
	for (const value of numbersShown(joined.join(""))) numbers.add(value);
	return numbers;
}

/**
 * The JSON-LD items of a document, parsed within the bounds (a block that is not JSON states nothing).
 * Each block is measured before its text is joined: one past the block bound, or past what the page's
 * blocks may hold together, is left out.
 *
 * @param root - The document.
 * @returns The parsed blocks, and whether a bound left any out.
 */
function jsonLdItems(root: Node): { items: unknown[]; truncated: boolean } {
	const items: unknown[] = [];
	let blocks = 0;
	let charsLeft = SEO_MARKUP_LIMITS.jsonChars;
	let truncated = false;
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) break;
		if ("tagName" in node && node.tagName === "script") {
			if ((attr(node, "type") ?? "").toLowerCase().includes("ld+json")) {
				blocks += 1;
				const size = node.childNodes.reduce(
					(sum, child) => sum + ("value" in child ? child.value.length : 0),
					0
				);
				if (
					blocks > SEO_MARKUP_LIMITS.jsonBlocks ||
					size > SEO_MARKUP_LIMITS.jsonBlockChars ||
					size > charsLeft
				) {
					truncated = true;
					continue;
				}
				charsLeft -= size;
				const text = node.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
				const read = parseBoundedJson(jsonLdText(text));
				if (read.kind === "value") items.push(read.value);
				else if (read.kind === "too_large") truncated = true;
			}
			continue;
		}
		if ("childNodes" in node) for (const child of node.childNodes) stack.push(child);
	}
	return { items, truncated };
}

/**
 * Reads a document's microdata and RDFa items and the prices and ratings its markup states.
 *
 * @param document - The parsed page.
 * @param base - The page's base URL.
 * @returns The items (as JSON text, within the limits), the marked values, and whether a bound cut
 *   the read short.
 */
export function readStructuredData(
	document: Node,
	base: string
): { items: SeoPageMarkupItem[]; markedValues: SeoPageMarkedValues[]; truncated: boolean } {
	const reading = newReading();
	const start: Scope = { current: null, itemDepth: 0, off: false, vocab: false };
	readItems(document, base, start, start, reading, 0);
	const limits = SEO_MARKUP_LIMITS;
	const items: SeoPageMarkupItem[] = [];
	let left = limits.structuredChars;
	let truncated = reading.truncated;
	for (const [syntax, list] of [
		["microdata", reading.microdata],
		["rdfa", reading.rdfa]
	] as const) {
		for (const item of list) {
			if (items.length >= limits.structuredItems || weightOf(reading, item) > left) {
				truncated = true;
				continue;
			}
			const json = JSON.stringify(item);
			if (json.length > left) {
				truncated = true;
				continue;
			}
			left -= json.length;
			items.push({ syntax, json });
		}
	}
	const jsonLd = jsonLdItems(document);
	const budget = walkBudget();
	const all = [...jsonLd.items, ...reading.microdata, ...reading.rdfa];
	const markedValues = markedValuesOf(all, pageNumbers(document), budget);
	truncated ||= jsonLd.truncated || budget.exhausted;
	return { items, markedValues, truncated };
}
