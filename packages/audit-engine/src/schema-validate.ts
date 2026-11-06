import {
	schemaAncestors,
	schemaDataType,
	schemaEnumeration,
	schemaEnumerationsOf,
	schemaProperty,
	schemaTypeKnown
} from "./schema-vocabulary";
import { spend, walkBudget } from "./structured-json";
import type { WalkBudget } from "./structured-json";

/**
 * THE SCHEMA.ORG VOCABULARY CHECK of one structured data item (JSON-LD, or microdata and RDFa read
 * into the same shape): unknown types and properties, a property used on a type it does not apply
 * to, and values of the wrong kind (an object of an unrelated type, a value outside an enumeration,
 * a date or a duration that is not ISO 8601). Pure.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - only schema.org terms are judged: a type or property of another vocabulary (`og:type`, a full
 *   URL elsewhere, a term the item's own `@context` defines) is left alone;
 * - text is accepted wherever an entity is expected (schema.org's own rule), and an object of a
 *   broader type (`Thing` where a `Brand` is expected) or a `Role` wrapper is accepted;
 * - an object without a `@type` is not judged, nor are its properties (its type is unknown);
 * - a date, a duration or an enumeration value is judged only where the property accepts nothing
 *   else (no `Text` alternative).
 */

/** What is wrong with one term. */
export type SchemaVocabularyProblem =
	| "unknown_type"
	| "unknown_property"
	| "property_not_for_type"
	| "value_type"
	| "enumeration_value"
	| "date"
	| "duration";

/** One vocabulary problem: the item's type, the property, the value as written, and the problem. */
export interface SchemaVocabularyIssue {
	type: string;
	property: string | null;
	value: string | null;
	problem: SchemaVocabularyProblem;
}

/** A JSON object. */
type JsonObject = Record<string, unknown>;

/** How deep the walk goes. */
const MAX_DEPTH = 10;

/** How many problems one item reports at most. */
const MAX_ISSUES = 50;

/** A schema.org term written with the vocabulary's prefix or address. */
const SCHEMA_PREFIX = /^(?:schema:|https?:\/\/(?:www\.)?schema\.org\/)/i;

/**
 * The longest value judged as a date or a duration. Far above any real ISO 8601 value; a longer one is
 * not a date or a duration, so it is reported without being matched.
 */
const MAX_TEMPORAL_CHARS = 64;

/** An ISO 8601 date or date-time, matched only on a value within {@link MAX_TEMPORAL_CHARS}. */
const ISO_DATE_TIME =
	/^-?\d{4}(?:-\d{2}(?:-\d{2})?)?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** An ISO 8601 time, matched only on a value within {@link MAX_TEMPORAL_CHARS}. */
const ISO_TIME = /^\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** The designators of a duration's date part, in the order they must appear. */
const DURATION_DATE_UNITS = "YMWD";

/** The designators of a duration's time part, in the order they must appear. */
const DURATION_TIME_UNITS = "HMS";
/** An action's input or output annotation (`query-input`), which is not a vocabulary property. */
const ACTION_ANNOTATION = /-(?:input|output)$/;

/** The temporal data types. */
const TEMPORAL = new Set(["Date", "DateTime", "Time"]);

/** The data types a plain text value satisfies. */
const TEXTUAL = new Set(["Text", "URL", "CssSelectorType", "XPathType", "PronounceableText"]);

/**
 * Whether a value is a JSON object.
 *
 * @param value - The value.
 * @returns Whether it is one.
 */
function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A term's schema.org local name, or null when it belongs to another vocabulary.
 *
 * @param term - The term as written.
 * @returns The local name, or null.
 */
export function schemaLocalName(term: string): string | null {
	const trimmed = term.trim();
	if (trimmed === "") return null;
	if (SCHEMA_PREFIX.test(trimmed))
		return withoutTrailingSlashes(trimmed.replace(SCHEMA_PREFIX, ""));
	return /[:/#]/.test(trimmed) ? null : trimmed;
}

/**
 * A text without its trailing slashes, in one pass from the end (a pattern anchored only at the end
 * would rescan the slashes from every start).
 *
 * @param text - The text.
 * @returns It, trailing slashes removed.
 */
function withoutTrailingSlashes(text: string): string {
	let end = text.length;
	while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1;
	return text.slice(0, end);
}

/**
 * Whether a value is an ISO 8601 date, date-time or time (what `Date`, `DateTime` and `Time` values
 * must be). Linear: the value is measured first, then matched by anchored patterns without nested
 * quantifiers.
 *
 * @param text - The value, trimmed.
 * @returns Whether it is one.
 */
function isoTemporal(text: string): boolean {
	if (text.length > MAX_TEMPORAL_CHARS) return false;
	return ISO_DATE_TIME.test(text) || ISO_TIME.test(text);
}

/**
 * The index past a run of ASCII digits.
 *
 * @param text - The text.
 * @param from - Where the run starts.
 * @returns The index past it (`from` when there is none).
 */
function digitsEnd(text: string, from: number): number {
	let index = from;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code < 48 || code > 57) break;
		index += 1;
	}
	return index;
}

/**
 * Whether a value is an ISO 8601 duration (`PT1H30M`, `P2D`, `-P1.5Y`): a `P`, then numbers each
 * followed by a designator in order (`Y`, `M`, `W`, `D`), then an optional `T` and its own (`H`, `M`,
 * `S`), with at least one number in all and one after a `T`. One pass over a value measured first.
 *
 * @param text - The value, trimmed.
 * @returns Whether it is one.
 */
function isoDuration(text: string): boolean {
	if (text.length > MAX_TEMPORAL_CHARS) return false;
	let index = text.startsWith("-") ? 1 : 0;
	if (text[index] !== "P") return false;
	index += 1;
	let units = DURATION_DATE_UNITS;
	let next = 0;
	let parts = 0;
	let timeParts = -1;
	while (index < text.length) {
		if (text[index] === "T" && timeParts < 0) {
			units = DURATION_TIME_UNITS;
			next = 0;
			timeParts = 0;
			index += 1;
			continue;
		}
		const whole = digitsEnd(text, index);
		if (whole === index) return false;
		index = whole;
		if (text[index] === "." || text[index] === ",") {
			const fraction = digitsEnd(text, index + 1);
			if (fraction === index + 1) return false;
			index = fraction;
		}
		const designator = text[index];
		if (designator === undefined) return false;
		const unit = units.indexOf(designator, next);
		if (unit < 0) return false;
		next = unit + 1;
		parts += 1;
		if (timeParts >= 0) timeParts += 1;
		index += 1;
	}
	return parts > 0 && timeParts !== 0;
}

/**
 * The schema.org types an item names, local names, other vocabularies left out.
 *
 * @param item - The item.
 * @returns Its types.
 */
function itemTypes(item: JsonObject): string[] {
	const raw = item["@type"];
	return (Array.isArray(raw) ? raw : [raw])
		.filter((value): value is string => typeof value === "string")
		.map(schemaLocalName)
		.filter((value): value is string => value !== null);
}

/**
 * A value cut short for a finding.
 *
 * @param value - The value.
 * @returns It, as text.
 */
function shown(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Whether a known type fits a range: it is a range type or below one, or above one (a broader type is
 * vague, not wrong), or a `Role` wrapper.
 *
 * @param type - The value's type.
 * @param ranges - The property's range.
 * @returns Whether it fits.
 */
function typeFits(type: string, ranges: readonly string[]): boolean {
	const above = schemaAncestors(type);
	if (above.has("Role")) return true;
	return ranges.some((range) => above.has(range) || schemaAncestors(range).has(type));
}

/**
 * Whether a text value names a member of one of the range's enumerations.
 *
 * @param value - The value as written.
 * @param enumerations - The range's enumerations.
 * @returns Whether it does.
 */
function enumerationMember(value: string, enumerations: readonly string[]): boolean {
	const name = schemaLocalName(value);
	if (name === null) return false;
	const lower = name.toLowerCase();
	const candidates = [name, lower.charAt(0).toUpperCase() + name.slice(1)];
	return candidates.some((candidate) => {
		const memberOf = schemaEnumerationsOf(candidate);
		return (
			memberOf !== null &&
			memberOf.some((enumeration) =>
				enumerations.some((range) => schemaAncestors(enumeration).has(range))
			)
		);
	});
}

/**
 * The problem with a literal value, judged against the property's range.
 *
 * @param value - The literal.
 * @param ranges - The property's range.
 * @returns The problem, or null.
 */
function literalProblem(value: unknown, ranges: readonly string[]): SchemaVocabularyProblem | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text === "" || ranges.some((range) => TEXTUAL.has(range))) return null;
	if (ranges.every((range) => TEMPORAL.has(range))) return isoTemporal(text) ? null : "date";
	if (ranges.includes("Duration")) {
		return isoDuration(text) ? null : "duration";
	}
	const enumerations = ranges.filter(schemaEnumeration);
	if (enumerations.length > 0 && enumerations.length === ranges.length) {
		return enumerationMember(text, enumerations) ? null : "enumeration_value";
	}
	return null;
}

/** The walk's state. */
interface Walk {
	issues: SchemaVocabularyIssue[];
	/** Terms the item's `@context` defines itself (another vocabulary's). */
	ownTerms: ReadonlySet<string>;
	/** The values the walk may still visit. */
	budget: WalkBudget;
}

/**
 * Records a problem while the walk is under its bound.
 *
 * @param walk - The state.
 * @param issue - The problem.
 */
function report(walk: Walk, issue: SchemaVocabularyIssue): void {
	if (walk.issues.length < MAX_ISSUES) walk.issues.push(issue);
}

/**
 * Checks one value of a property.
 *
 * @param value - The value.
 * @param ranges - The property's range.
 * @param owner - The type holding the property.
 * @param property - The property.
 * @param depth - How deep the walk is.
 * @param walk - The state.
 */
function checkValue(
	value: unknown,
	ranges: readonly string[],
	owner: string,
	property: string,
	depth: number,
	walk: Walk
): void {
	if (walk.issues.length >= MAX_ISSUES || !spend(walk.budget)) return;
	if (Array.isArray(value)) {
		for (const entry of value) checkValue(entry, ranges, owner, property, depth, walk);
		return;
	}
	if (!isObject(value)) {
		const problem = literalProblem(value, ranges);
		if (problem !== null) report(walk, { type: owner, property, value: shown(value), problem });
		return;
	}
	if ("@value" in value) {
		const problem = literalProblem(value["@value"], ranges);
		if (problem !== null)
			report(walk, { type: owner, property, value: shown(value["@value"]), problem });
		return;
	}
	const types = itemTypes(value);
	if (types.length === 0) {
		const id = value["@id"];
		if (typeof id === "string" && Object.keys(value).every((key) => key.startsWith("@"))) {
			const problem = SCHEMA_PREFIX.test(id) ? literalProblem(id, ranges) : null;
			if (problem !== null) report(walk, { type: owner, property, value: shown(id), problem });
		}
		return;
	}
	const known = types.filter(schemaTypeKnown);
	if (
		known.length > 0 &&
		ranges.length > 0 &&
		!ranges.every(schemaDataType) &&
		!known.some((type) => typeFits(type, ranges))
	) {
		report(walk, { type: owner, property, value: known.join(", "), problem: "value_type" });
	} else if (known.length > 0 && ranges.length > 0 && ranges.every(schemaDataType)) {
		report(walk, { type: owner, property, value: known.join(", "), problem: "value_type" });
	}
	checkItem(value, depth + 1, walk);
}

/**
 * Checks one typed item and everything under it.
 *
 * @param item - The item.
 * @param depth - How deep the walk is.
 * @param walk - The state.
 */
function checkItem(item: JsonObject, depth: number, walk: Walk): void {
	if (depth > MAX_DEPTH || walk.issues.length >= MAX_ISSUES || !spend(walk.budget)) return;
	const types = itemTypes(item);
	if (types.length === 0) return;
	const unknown = types.filter(
		(type) => !schemaTypeKnown(type) && schemaEnumerationsOf(type) === null
	);
	for (const type of unknown)
		report(walk, { type, property: null, value: null, problem: "unknown_type" });
	const known = types.filter(schemaTypeKnown);
	const owner = known[0] ?? types[0] ?? "";
	const above = new Set(known.flatMap((type) => [...schemaAncestors(type)]));
	for (const [key, value] of Object.entries(item)) {
		if (key.startsWith("@") || walk.ownTerms.has(key) || ACTION_ANNOTATION.test(key)) continue;
		const property = schemaLocalName(key);
		if (property === null) continue;
		const info = schemaProperty(property);
		if (info === null) {
			report(walk, { type: owner, property, value: null, problem: "unknown_property" });
			continue;
		}
		if (known.length > 0 && info.domains.length > 0 && !info.domains.some((d) => above.has(d))) {
			report(walk, { type: owner, property, value: null, problem: "property_not_for_type" });
		}
		checkValue(value, info.ranges, owner, property, depth, walk);
	}
}

/**
 * The terms a JSON-LD `@context` defines itself (an object context's keys other than `@vocab` and the
 * like), which belong to whatever vocabulary it maps them to.
 *
 * @param context - The context.
 * @returns The terms.
 */
export function contextTerms(context: unknown): Set<string> {
	const terms = new Set<string>();
	const list = Array.isArray(context) ? context : [context];
	for (const entry of list) {
		if (!isObject(entry)) continue;
		for (const key of Object.keys(entry)) if (!key.startsWith("@")) terms.add(key);
	}
	return terms;
}

/**
 * The vocabulary problems of one item Google reads (a top-level item or a `@graph` member) and of
 * everything nested in it.
 *
 * @param item - The item.
 * @param ownTerms - The terms its `@context` defines itself.
 * @param budget - The values the walk may visit, shared by every item of a page (a fresh budget when
 *   omitted).
 * @returns The problems, at most a few dozen.
 */
export function schemaVocabularyIssues(
	item: JsonObject,
	ownTerms: ReadonlySet<string> = new Set(),
	budget: WalkBudget = walkBudget()
): SchemaVocabularyIssue[] {
	const walk: Walk = { issues: [], ownTerms, budget };
	checkItem(item, 0, walk);
	return walk.issues.slice(0, MAX_ISSUES);
}
