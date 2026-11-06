import { SEO_MARKUP_LIMITS } from "./reading-limits";

/**
 * BOUNDED JSON FOR THE STRUCTURED DATA CHECKS: a page's markup is untrusted, so every block is measured
 * before it is parsed (its size and how deep it nests, in one linear scan) and every walk over a parsed
 * item counts the values it visits. A block past a bound is reported as too large, never parsed, and
 * never fails the page. The same bounds hold for the server's crawl and a member's computer
 * ({@link SEO_MARKUP_LIMITS}). `@id` references are looked up one hop at a time, never expanded, so a
 * cycle or a self-referencing graph cannot multiply the work. Pure.
 */

/** A JSON object. */
export type JsonObject = Record<string, unknown>;

/** What reading one block gave: its value, text that is not JSON, or a block past the bounds. */
export type BoundedJson =
	{ kind: "value"; value: unknown } | { kind: "invalid" } | { kind: "too_large" };

/**
 * Whether a value is a JSON object.
 *
 * @param value - The value.
 * @returns Whether it is one.
 */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether JSON text nests no deeper than a bound, read in one pass that skips strings.
 *
 * @param text - The text.
 * @param maxDepth - The deepest nesting allowed.
 * @returns Whether it stays within it.
 */
export function jsonNestingWithin(text: string, maxDepth: number): boolean {
	let depth = 0;
	let inString = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text.charCodeAt(index);
		if (inString) {
			if (char === 92) index += 1;
			else if (char === 34) inString = false;
			continue;
		}
		if (char === 34) inString = true;
		else if (char === 123 || char === 91) {
			depth += 1;
			if (depth > maxDepth) return false;
		} else if (char === 125 || char === 93) depth -= 1;
	}
	return true;
}

/**
 * Parses one block of JSON within the bounds.
 *
 * @param text - The block's JSON text.
 * @returns The value, or why it was not read.
 */
export function parseBoundedJson(text: string): BoundedJson {
	if (text.length > SEO_MARKUP_LIMITS.jsonBlockChars) return { kind: "too_large" };
	if (!jsonNestingWithin(text, SEO_MARKUP_LIMITS.jsonDepth)) return { kind: "too_large" };
	try {
		return { kind: "value", value: JSON.parse(text) as unknown };
	} catch {
		return { kind: "invalid" };
	}
}

/** A count of the values a walk may still visit, shared by every walk over one page's items. */
export interface WalkBudget {
	left: number;
	/** Set once the walk ran out, so the page reports it checked part of its markup. */
	exhausted: boolean;
}

/**
 * A fresh budget for one page's walks.
 *
 * @returns The budget.
 */
export function walkBudget(): WalkBudget {
	return { left: SEO_MARKUP_LIMITS.jsonNodes, exhausted: false };
}

/**
 * Takes one visit from a budget.
 *
 * @param budget - The budget.
 * @returns Whether a visit was left.
 */
export function spend(budget: WalkBudget): boolean {
	if (budget.left <= 0) {
		budget.exhausted = true;
		return false;
	}
	budget.left -= 1;
	return true;
}

/**
 * Pushes a value onto a walk's stack while the budget can still visit everything on it, so a wide
 * array or object never queues more than the walk may visit.
 *
 * @param stack - The walk's stack.
 * @param entry - The entry to push.
 * @param budget - The page's walk budget.
 * @returns Whether it was pushed.
 */
export function pushWithin<T>(stack: T[], entry: T, budget: WalkBudget): boolean {
	if (stack.length >= budget.left) {
		budget.exhausted = true;
		return false;
	}
	stack.push(entry);
	return true;
}

/** The items of a page by `@id`, for one-hop lookups of references. */
export type IdIndex = ReadonlyMap<string, JsonObject>;

/**
 * Whether an object is only a reference to another item (`{"@id": ...}`, with at most a type).
 *
 * @param value - The object.
 * @returns Whether it is.
 */
export function isReference(value: JsonObject): boolean {
	if (typeof value["@id"] !== "string") return false;
	return Object.keys(value).every((key) => key === "@id" || key === "@type");
}

/**
 * Every described item of a page by its `@id` (a reference alone describes nothing), within the bounds.
 *
 * @param items - The page's items, every syntax.
 * @param budget - The page's walk budget.
 * @returns The index.
 */
export function indexIds(items: readonly unknown[], budget: WalkBudget): IdIndex {
	const index = new Map<string, JsonObject>();
	const stack: { value: unknown; depth: number }[] = items.map((value) => ({ value, depth: 0 }));
	while (stack.length > 0) {
		const next = stack.pop();
		if (next === undefined || !spend(budget)) break;
		const { value, depth } = next;
		if (depth > SEO_MARKUP_LIMITS.jsonDepth) continue;
		if (Array.isArray(value)) {
			for (const entry of value)
				if (!pushWithin(stack, { value: entry, depth: depth + 1 }, budget)) break;
			continue;
		}
		if (!isJsonObject(value)) continue;
		const id = value["@id"];
		if (
			typeof id === "string" &&
			!isReference(value) &&
			!index.has(id) &&
			index.size < SEO_MARKUP_LIMITS.jsonIds
		)
			index.set(id, value);
		for (const entry of Object.values(value))
			if (
				typeof entry === "object" &&
				entry !== null &&
				!pushWithin(stack, { value: entry, depth: depth + 1 }, budget)
			)
				break;
	}
	return index;
}

/**
 * An object with a reference replaced by the item it names (one hop; an unknown reference stays).
 *
 * @param value - The object.
 * @param ids - The page's items by `@id`.
 * @returns The item.
 */
export function dereferenced(value: JsonObject, ids: IdIndex): JsonObject {
	if (!isReference(value)) return value;
	const id = value["@id"];
	return typeof id === "string" ? (ids.get(id) ?? value) : value;
}
