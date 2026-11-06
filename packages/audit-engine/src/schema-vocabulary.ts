import vocabulary from "./schema-vocabulary.json";

/**
 * THE SCHEMA.ORG VOCABULARY the structured data checks validate against: every type with its parents,
 * every enumeration member, every property with the types it applies to (domain) and the types it
 * expects (range). Vendored from schema.org's published release file (`./schema-vocabulary.json`,
 * built by `scripts/build-schema-vocabulary.ts`; its `source` and `version` say which release), so the
 * audit reads the same vocabulary on every run and never fetches it.
 */

/** The vendored table's shape. */
interface VocabularyTable {
	source: string;
	version: string;
	retrieved: string;
	/** Type name to its direct parents. */
	types: Record<string, string[]>;
	/** Enumeration member name to the enumerations it belongs to. */
	members: Record<string, string[]>;
	/** Property name to its domain types (first) and its range types (second). */
	properties: Record<string, string[][]>;
	superseded: Record<string, string>;
}

const TABLE: VocabularyTable = vocabulary;

/** The release the table was built from, and where it came from. */
export const SCHEMA_ORG_VOCABULARY = {
	version: TABLE.version,
	source: TABLE.source,
	retrieved: TABLE.retrieved
} as const;

/** The data types whose values are written as text, and the temporal ones among them. */
const DATA_TYPES = new Set([
	"Text",
	"URL",
	"CssSelectorType",
	"XPathType",
	"PronounceableText",
	"Number",
	"Integer",
	"Float",
	"Boolean",
	"Date",
	"DateTime",
	"Time",
	"DataType"
]);

const ancestorCache = new Map<string, ReadonlySet<string>>();

/**
 * Whether a name is a schema.org type (a data type included).
 *
 * @param name - The type's local name.
 * @returns Whether the vocabulary has it.
 */
export function schemaTypeKnown(name: string): boolean {
	return Object.hasOwn(TABLE.types, name);
}

/**
 * The enumerations a name is a member of, or null when it is not one.
 *
 * @param name - The member's local name.
 * @returns The enumerations, or null.
 */
export function schemaEnumerationsOf(name: string): readonly string[] | null {
	return Object.hasOwn(TABLE.members, name) ? (TABLE.members[name] ?? null) : null;
}

/**
 * A type and every type above it.
 *
 * @param name - The type's local name.
 * @returns The type and its ancestors (empty for a name the vocabulary does not have).
 */
export function schemaAncestors(name: string): ReadonlySet<string> {
	const cached = ancestorCache.get(name);
	if (cached !== undefined) return cached;
	const found = new Set<string>();
	const queue = schemaTypeKnown(name) ? [name] : [];
	while (queue.length > 0) {
		const next = queue.pop();
		if (next === undefined || found.has(next)) continue;
		found.add(next);
		queue.push(...(TABLE.types[next] ?? []));
	}
	ancestorCache.set(name, found);
	return found;
}

/**
 * Whether a type is a data type (text, number, date, ...), whose values are literals.
 *
 * @param name - The type's local name.
 * @returns Whether it is.
 */
export function schemaDataType(name: string): boolean {
	return DATA_TYPES.has(name);
}

/**
 * Whether a type is an enumeration (a subtype of `Enumeration`).
 *
 * @param name - The type's local name.
 * @returns Whether it is.
 */
export function schemaEnumeration(name: string): boolean {
	return name !== "Enumeration" && schemaAncestors(name).has("Enumeration");
}

/** A property as the vocabulary describes it. */
export interface SchemaPropertyInfo {
	/** The types it applies to (it applies to their subtypes too). */
	domains: readonly string[];
	/** The types its values are expected to be. */
	ranges: readonly string[];
}

/**
 * A property, or null when the vocabulary does not have it.
 *
 * @param name - The property's local name.
 * @returns The property.
 */
export function schemaProperty(name: string): SchemaPropertyInfo | null {
	if (!Object.hasOwn(TABLE.properties, name)) return null;
	const entry = TABLE.properties[name];
	return entry === undefined ? null : { domains: entry[0] ?? [], ranges: entry[1] ?? [] };
}
