import { SEO_RICH_RESULT_SPECS } from "./rich-results-table";
import type { RichResultRequirements } from "./rich-results-table";
import { schemaLocalName } from "./schema-validate";
import { schemaAncestors, schemaTypeKnown } from "./schema-vocabulary";
import { dereferenced, isJsonObject, pushWithin, spend } from "./structured-json";
import type { IdIndex, JsonObject, WalkBudget } from "./structured-json";

/**
 * GOOGLE'S RICH RESULT REQUIREMENTS, judged on a page's structured data items (JSON-LD, microdata and
 * RDFa alike): for each item of a type Google shows a rich result for, the required and recommended
 * properties it lacks (the tables of `./rich-results-table`). Pure and bounded: every walk spends the
 * page's {@link WalkBudget}, references are looked up one hop at a time, and each path step reads a
 * capped number of values.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a dotted requirement applies to each value of its parent, and only when the parent is present;
 * - a value written as text where an item is expected (an author's name as a string) cannot be judged
 *   deeper and is never flagged for what it lacks;
 * - a reference (`{"@id": ...}`) is read as the item the page describes under that id.
 */

/** The values one path step reads at most. */
const STEP_VALUES = 200;

/** How deep the walk for nested items goes. */
const MAX_DEPTH = 10;

/** The requirements one item misses. */
export interface RichResultGap {
	/** The item's type (the one the table matched). */
	type: string;
	/** The requirements it misses, as written in the table. */
	missing: string[];
}

/** The gaps of a page's items: required and recommended apart. */
export interface RichResultGaps {
	required: RichResultGap[];
	recommended: RichResultGap[];
}

/**
 * The schema.org types an item names, local names.
 *
 * @param item - The item.
 * @returns Its types.
 */
function typesOf(item: JsonObject): string[] {
	const raw = item["@type"];
	return (Array.isArray(raw) ? raw : [raw])
		.filter((value): value is string => typeof value === "string")
		.map(schemaLocalName)
		.filter((value): value is string => value !== null && value !== "");
}

/**
 * The table entries an item's types fall under, the most specific of each line only (a `Restaurant`
 * is checked as a `LocalBusiness`, never also as an `Organization`).
 *
 * @param types - The item's types.
 * @returns The matched table keys.
 */
export function richResultTypes(types: readonly string[]): string[] {
	const matched = new Set<string>();
	for (const type of types) {
		const line = schemaTypeKnown(type) ? schemaAncestors(type) : new Set([type]);
		const candidates = [...line].filter((name) => Object.hasOwn(SEO_RICH_RESULT_SPECS, name));
		for (const candidate of candidates) {
			const broader = candidates.some(
				(other) => other !== candidate && schemaAncestors(other).has(candidate)
			);
			if (!broader) matched.add(candidate);
		}
	}
	return [...matched];
}

/**
 * Whether a value is present: not empty text, not an empty list, not null.
 *
 * @param value - The value.
 * @returns Whether it is present.
 */
function present(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

/**
 * The items a property holds (references looked up, text and numbers left out), a capped number.
 *
 * @param parents - The items holding it.
 * @param property - The property.
 * @param ids - The page's items by `@id`.
 * @param budget - The page's walk budget.
 * @returns The items.
 */
function step(
	parents: readonly JsonObject[],
	property: string,
	ids: IdIndex,
	budget: WalkBudget
): JsonObject[] {
	const found: JsonObject[] = [];
	for (const parent of parents) {
		const raw = parent[property];
		for (const value of Array.isArray(raw) ? raw : [raw]) {
			if (found.length >= STEP_VALUES || !spend(budget)) return found;
			if (isJsonObject(value)) found.push(dereferenced(value, ids));
		}
	}
	return found;
}

/**
 * Whether a path holds a present value under an item.
 *
 * @param item - The item.
 * @param path - The path's steps.
 * @param ids - The page's items by `@id`.
 * @param budget - The page's walk budget.
 * @returns Whether it does.
 */
function pathPresent(
	item: JsonObject,
	path: readonly string[],
	ids: IdIndex,
	budget: WalkBudget
): boolean {
	const last = path.at(-1);
	if (last === undefined) return false;
	const parents = path
		.slice(0, -1)
		.reduce<JsonObject[]>((current, property) => step(current, property, ids, budget), [item]);
	return parents.some((parent) => present(parent[last]));
}

/**
 * Whether an item misses a requirement: some value of the alternatives' shared parent holds none of
 * them (an absent parent misses nothing).
 *
 * @param item - The item.
 * @param requirement - The requirement, `a.b|a.c` style.
 * @param ids - The page's items by `@id`.
 * @param budget - The page's walk budget.
 * @returns Whether it misses it.
 */
function misses(item: JsonObject, requirement: string, ids: IdIndex, budget: WalkBudget): boolean {
	const alternatives = requirement.split("|").map((path) => path.split("."));
	const shared: string[] = [];
	for (let index = 0; ; index += 1) {
		const name = alternatives[0]?.[index];
		const everyHas = alternatives.every((path) => index < path.length - 1 && path[index] === name);
		if (name === undefined || !everyHas) break;
		shared.push(name);
	}
	const parents = shared.reduce<JsonObject[]>(
		(current, property) => step(current, property, ids, budget),
		[item]
	);
	return parents.some(
		(parent) =>
			!alternatives.some((path) => pathPresent(parent, path.slice(shared.length), ids, budget))
	);
}

/**
 * The requirements of one set an item misses.
 *
 * @param item - The item.
 * @param requirements - The paths.
 * @param ids - The page's items by `@id`.
 * @param budget - The page's walk budget.
 * @returns The ones it misses.
 */
function missingOf(
	item: JsonObject,
	requirements: readonly string[],
	ids: IdIndex,
	budget: WalkBudget
): string[] {
	return requirements.filter((requirement) => misses(item, requirement, ids, budget));
}

/**
 * Adds an item's gaps for each table entry it falls under.
 *
 * @param item - The item.
 * @param nested - Whether it sits inside another item.
 * @param ids - The page's items by `@id`.
 * @param budget - The page's walk budget.
 * @param into - The page's gaps.
 */
function judge(
	item: JsonObject,
	nested: boolean,
	ids: IdIndex,
	budget: WalkBudget,
	into: RichResultGaps
): void {
	for (const type of richResultTypes(typesOf(item))) {
		const spec = SEO_RICH_RESULT_SPECS[type];
		if (spec === undefined) continue;
		const set: RichResultRequirements | undefined = nested ? spec.nested : spec;
		if (set === undefined) continue;
		const required = missingOf(item, set.required, ids, budget);
		if (required.length > 0) into.required.push({ type, missing: required });
		const recommended = missingOf(item, set.recommended, ids, budget);
		if (recommended.length > 0) into.recommended.push({ type, missing: recommended });
	}
}

/**
 * The rich result gaps of a page's items: each top-level item (a `@graph` member counts as one) against
 * its type's set, and each item nested in it against its type's nested set.
 *
 * @param items - The page's top-level items, every syntax.
 * @param ids - The page's items by `@id`.
 * @param budget - The page's walk budget.
 * @returns The gaps.
 */
export function richResultGaps(
	items: readonly JsonObject[],
	ids: IdIndex,
	budget: WalkBudget
): RichResultGaps {
	const gaps: RichResultGaps = { required: [], recommended: [] };
	for (const item of items) {
		judge(item, false, ids, budget, gaps);
		const stack: { value: unknown; depth: number }[] = Object.entries(item)
			.filter(([key]) => !key.startsWith("@"))
			.map(([, value]) => ({ value, depth: 1 }));
		while (stack.length > 0) {
			const next = stack.pop();
			if (next === undefined || !spend(budget)) break;
			const { value, depth } = next;
			if (depth > MAX_DEPTH) continue;
			if (Array.isArray(value)) {
				for (const entry of value) if (!pushWithin(stack, { value: entry, depth }, budget)) break;
				continue;
			}
			if (!isJsonObject(value) || Object.keys(value).every((key) => key.startsWith("@"))) continue;
			judge(value, true, ids, budget, gaps);
			for (const [key, entry] of Object.entries(value))
				if (
					!key.startsWith("@") &&
					typeof entry === "object" &&
					entry !== null &&
					!pushWithin(stack, { value: entry, depth: depth + 1 }, budget)
				)
					break;
		}
	}
	return gaps;
}
