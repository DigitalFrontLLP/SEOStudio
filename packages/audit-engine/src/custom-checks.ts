import type { SeoCustomCheck, SeoPageCustomResult } from "./facts";
import { compile, selectAll } from "css-select";
import type { Options } from "css-select";
import { isTag } from "domhandler";
import type { AnyNode, Element } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";
import { MatcherInput, RE2JS } from "re2js";

import { SEO_CUSTOM_CHECK_LIMITS } from "./reading-limits";

/**
 * THE PROJECT'S OWN SEARCH AND EXTRACTION PATTERNS, run on a page's HTML while it is read (the rendered
 * page whenever the browser rendered it): plain text, a regular expression or a CSS selector, each
 * counting its matches and, for an extraction, keeping the first values. Only the results are kept,
 * never the page.
 *
 * SAFE BY CONSTRUCTION: a regular expression is matched by RE2 (`re2js`), whose time grows linearly
 * with the page, never exponentially, and is refused when saved past a size; and every pattern runs
 * on a metered share of one page's work budget (`pageWork`), counted as it reads, so neither a costly
 * pattern nor a crafted page can stall a crawl, on the server or on a member's computer. The HTML
 * read, the matches counted, the values kept and their length are capped too. A pattern that cannot
 * be compiled, or spends its share on a page, yields no result there (never a page "without" it). Pure.
 */

export { SEO_CUSTOM_CHECK_LIMITS };

/** A compiled pattern: how it counts and extracts over one page. */
type CompiledCheck =
	| { kind: "text"; needle: string }
	| { kind: "regex"; regex: RE2JS }
	| { kind: "css"; selector: string };

/** Why a pattern cannot be saved. */
export type SeoCustomCheckProblem = "invalid_pattern" | "too_complex" | "extract_needs_pattern";

/** What a member or an agent reads when a pattern is refused. */
export const SEO_CUSTOM_CHECK_PROBLEM_MESSAGES: Readonly<Record<SeoCustomCheckProblem, string>> = {
	invalid_pattern:
		"The pattern does not compile. A regular expression uses RE2 syntax (no lookarounds or backreferences); a selector must be valid CSS.",
	too_complex: `The regular expression is too large to run on every page (over ${SEO_CUSTOM_CHECK_LIMITS.regexProgram} steps once compiled). Use fewer or smaller repeats.`,
	extract_needs_pattern:
		"An extraction needs a regular expression or a CSS selector, not plain text."
};

/**
 * Compiles one pattern, or says why it cannot be (a malformed expression or selector, or an
 * expression too large to run on every page).
 *
 * @param check - The pattern.
 * @returns The compiled pattern, or the reason.
 */
function compileCheck(
	check: Pick<SeoCustomCheck, "match" | "pattern">
): CompiledCheck | "invalid_pattern" | "too_complex" {
	const pattern = check.pattern;
	if (pattern === "" || pattern.length > SEO_CUSTOM_CHECK_LIMITS.patternChars)
		return "invalid_pattern";
	try {
		switch (check.match) {
			case "text":
				return { kind: "text", needle: pattern.toLowerCase() };
			case "regex": {
				const regex = RE2JS.compile(pattern);
				return regex.programSize() > SEO_CUSTOM_CHECK_LIMITS.regexProgram
					? "too_complex"
					: { kind: "regex", regex };
			}
			case "css":
				compile(pattern);
				return { kind: "css", selector: pattern };
		}
	} catch {
		return "invalid_pattern";
	}
	return "invalid_pattern";
}

/**
 * Why a pattern cannot be saved, or null when it can: its expression or selector must compile, an
 * expression must be small enough to run on every page, and an extraction needs a regular expression
 * or a selector (plain text has nothing to extract).
 *
 * @param check - The pattern.
 * @returns The reason, or null.
 */
export function customCheckProblem(
	check: Pick<SeoCustomCheck, "mode" | "match" | "pattern">
): SeoCustomCheckProblem | null {
	if (check.mode === "extract" && check.match === "text") return "extract_needs_pattern";
	const compiled = compileCheck(check);
	return typeof compiled === "string" ? compiled : null;
}

/** Thrown when a pattern has spent its share of a page's work. */
class OutOfWork extends Error {}

/** One pattern's share of a page's work, spent as it runs. */
class WorkMeter {
	#left: number;

	/**
	 * @param budget - The work the pattern may do.
	 */
	constructor(budget: number) {
		this.#left = budget;
	}

	/**
	 * Spends work, or stops the pattern when its share is gone.
	 *
	 * @param units - The work done.
	 */
	spend(units: number): void {
		this.#left -= Math.max(0, units);
		if (this.#left < 0) throw new OutOfWork();
	}
}

/**
 * The HTML as RE2 reads it, every character read charged to the pattern's meter at the expression's
 * size (the most work one step of the match can do), so a long, repeated scan stops at its share.
 */
class MeteredText {
	readonly length: number;
	readonly #text: string;
	readonly #meter: WorkMeter;
	readonly #stepCost: number;

	/**
	 * @param text - The HTML.
	 * @param meter - The pattern's meter.
	 * @param stepCost - The work of reading one character (the expression's size).
	 */
	constructor(text: string, meter: WorkMeter, stepCost: number) {
		this.length = text.length;
		this.#text = text;
		this.#meter = meter;
		this.#stepCost = stepCost;
	}

	/**
	 * One UTF-16 unit, charged.
	 *
	 * @param index - Where.
	 * @returns The unit.
	 */
	charCodeAt(index: number): number {
		this.#meter.spend(this.#stepCost);
		return this.#text.charCodeAt(index);
	}

	/**
	 * Where a literal next occurs, the characters scanned charged.
	 *
	 * @param search - The literal.
	 * @param from - Where the scan starts.
	 * @returns Its index, or -1.
	 */
	indexOf(search: string, from: number): number {
		const at = this.#text.indexOf(search, from);
		this.#meter.spend((at < 0 ? this.length : at + search.length) - from);
		return at;
	}

	/**
	 * A part of the HTML, its length charged.
	 *
	 * @param start - Its start.
	 * @param end - Its end.
	 * @returns The part.
	 */
	substring(start: number, end: number): string {
		this.#meter.spend(end - start);
		return this.#text.substring(start, end);
	}

	/**
	 * The whole HTML, its length charged.
	 *
	 * @returns The HTML.
	 */
	toString(): string {
		this.#meter.spend(this.length);
		return this.#text;
	}
}

/** The DOM access a selector runs through. */
type SelectorAdapter = NonNullable<Options<AnyNode, Element>["adapter"]>;

/**
 * The page's DOM as a selector reads it, every step through it charged to the pattern's meter (a
 * list of children or siblings at its length, a text at its characters).
 *
 * @param meter - The pattern's meter.
 * @returns The adapter.
 */
function meteredAdapter(meter: WorkMeter): SelectorAdapter {
	return {
		isTag: (node: AnyNode): node is Element => {
			meter.spend(1);
			return isTag(node);
		},
		getAttributeValue: (element, name) => {
			meter.spend(1);
			return DomUtils.getAttributeValue(element, name);
		},
		getChildren: (node) => {
			const children = DomUtils.getChildren(node);
			meter.spend(1 + children.length);
			return children;
		},
		getName: (element) => {
			meter.spend(1);
			return DomUtils.getName(element);
		},
		getParent: (node) => {
			meter.spend(1);
			return DomUtils.getParent(node);
		},
		getSiblings: (node) => {
			const siblings = DomUtils.getSiblings(node);
			meter.spend(1 + siblings.length);
			return siblings;
		},
		prevElementSibling: (node) => {
			meter.spend(1);
			return DomUtils.prevElementSibling(node);
		},
		getText: (node) => {
			const text = DomUtils.getText(node);
			meter.spend(1 + text.length);
			return text;
		},
		hasAttrib: (element, name) => {
			meter.spend(1);
			return DomUtils.hasAttrib(element, name);
		},
		removeSubsets: (nodes) => {
			meter.spend(nodes.length);
			return DomUtils.removeSubsets(nodes);
		}
	};
}

/**
 * A value cut to its bound, its white space folded.
 *
 * @param value - The value.
 * @returns The value kept.
 */
function keptValue(value: string): string {
	const folded = value.replace(/\s+/gu, " ").trim();
	return folded.length > SEO_CUSTOM_CHECK_LIMITS.valueChars
		? folded.slice(0, SEO_CUSTOM_CHECK_LIMITS.valueChars)
		: folded;
}

/**
 * How often a plain text occurs in the HTML, case-insensitive.
 *
 * @param lower - The HTML, lowercased.
 * @param needle - The text, lowercased.
 * @returns The count, capped.
 */
function countText(lower: string, needle: string): number {
	let count = 0;
	let from = 0;
	while (count < SEO_CUSTOM_CHECK_LIMITS.matches) {
		const at = lower.indexOf(needle, from);
		if (at < 0) break;
		count += 1;
		from = at + needle.length;
	}
	return count;
}

/**
 * A regular expression's matches over the HTML: how many, and the values (its first group when it has
 * one, else the whole match). Throws {@link OutOfWork} when it spends its share.
 *
 * @param html - The HTML.
 * @param regex - The expression.
 * @param extract - Whether values are kept.
 * @param meter - The pattern's share of the page's work.
 * @returns The count and the values.
 */
function runRegex(
	html: string,
	regex: RE2JS,
	extract: boolean,
	meter: WorkMeter
): { count: number; values: string[] } {
	const matcher = regex.matcher(
		MatcherInput.utf16(new MeteredText(html, meter, Math.max(1, regex.programSize())))
	);
	const values: string[] = [];
	let count = 0;
	while (count < SEO_CUSTOM_CHECK_LIMITS.matches && matcher.find()) {
		count += 1;
		if (extract && values.length < SEO_CUSTOM_CHECK_LIMITS.values) {
			const value = matcher.groupCount() > 0 ? matcher.group(1) : matcher.group(0);
			if (value !== null && value.trim() !== "") values.push(keptValue(value));
		}
	}
	return { count, values };
}

/**
 * A selector's matches in the page: how many elements, and the values (an attribute's, or the text).
 *
 * @param elements - The matched elements.
 * @param attribute - The attribute extracted, or null for the text.
 * @param extract - Whether values are kept.
 * @returns The count and the values.
 */
function runSelector(
	elements: readonly Element[],
	attribute: string | null,
	extract: boolean
): { count: number; values: string[] } {
	const values: string[] = [];
	if (extract) {
		for (const element of elements) {
			if (values.length >= SEO_CUSTOM_CHECK_LIMITS.values) break;
			const value =
				attribute === null ? DomUtils.textContent(element) : (element.attribs[attribute] ?? "");
			if (value.trim() !== "") values.push(keptValue(value));
		}
	}
	return { count: Math.min(elements.length, SEO_CUSTOM_CHECK_LIMITS.matches), values };
}

/**
 * Runs a project's patterns over one page's HTML, each on an even share of the page's work budget.
 *
 * @param html - The page's HTML (the rendered page whenever the browser rendered it).
 * @param checks - The project's patterns.
 * @returns One result per pattern that compiled and finished within its share.
 */
export function runCustomChecks(
	html: string,
	checks: readonly SeoCustomCheck[]
): SeoPageCustomResult[] {
	if (checks.length === 0) return [];
	const source =
		html.length > SEO_CUSTOM_CHECK_LIMITS.htmlChars
			? html.slice(0, SEO_CUSTOM_CHECK_LIMITS.htmlChars)
			: html;
	let lower: string | null = null;
	let document: ReturnType<typeof parseDocument> | null = null;
	const results: SeoPageCustomResult[] = [];
	const run = checks.slice(0, SEO_CUSTOM_CHECK_LIMITS.checks);
	const share = Math.floor(SEO_CUSTOM_CHECK_LIMITS.pageWork / run.length);
	for (const check of run) {
		const compiled = compileCheck(check);
		if (typeof compiled === "string") continue;
		const extract = check.mode === "extract";
		const meter = new WorkMeter(share);
		let found: { count: number; values: string[] };
		try {
			if (compiled.kind === "text") {
				lower ??= source.toLowerCase();
				found = { count: countText(lower, compiled.needle), values: [] };
			} else if (compiled.kind === "regex") {
				found = runRegex(source, compiled.regex, extract, meter);
			} else {
				document ??= parseDocument(source);
				const elements = selectAll<AnyNode, Element>(compiled.selector, document, {
					adapter: meteredAdapter(meter)
				});
				found = runSelector(elements, check.attribute, extract);
			}
		} catch {
			continue;
		}
		results.push({ id: check.id, count: found.count, values: found.values });
	}
	return results;
}
