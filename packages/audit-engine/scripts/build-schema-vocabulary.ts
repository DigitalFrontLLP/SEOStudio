/**
 * `pnpm --filter @seostudio/audit-engine exec tsx scripts/build-schema-vocabulary.ts <schemaorg-current-https.jsonld> <version>`
 * - turns schema.org's published vocabulary file into the compact table the site audit vendors
 * (`src/schema-vocabulary.json`): every type with its parents, every enumeration member with
 * its enumerations, every property with the types it applies to and the types it expects, and the
 * terms schema.org says are superseded.
 *
 * Download the file from `https://schema.org/version/<version>/schemaorg-current-https.jsonld` (the
 * release named on https://schema.org/docs/releases.html) and pass its path and version. The output is
 * committed, so the audit never fetches the vocabulary at run time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One node of the vocabulary graph, as much of it as the table reads. */
interface VocabularyNode {
	"@id": string;
	"@type": string | string[];
	"rdfs:subClassOf"?: { "@id": string } | { "@id": string }[];
	"schema:domainIncludes"?: { "@id": string } | { "@id": string }[];
	"schema:rangeIncludes"?: { "@id": string } | { "@id": string }[];
	"schema:supersededBy"?: { "@id": string } | { "@id": string }[];
}

/** `packages/seo` - this script sits one level below it. */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A node field that may hold one reference or several, as the schema.org local names it names.
 *
 * @param value - The field.
 * @returns The names (schema.org terms only).
 */
function names(value: { "@id": string } | { "@id": string }[] | undefined): string[] {
	if (value === undefined) return [];
	return (Array.isArray(value) ? value : [value])
		.map((entry) => entry["@id"])
		.filter((id) => id.startsWith("schema:"))
		.map((id) => id.slice("schema:".length))
		.sort();
}

/**
 * Builds the table and writes it.
 *
 * @param source - The path of the downloaded vocabulary file.
 * @param version - Its schema.org release.
 */
function main(source: string, version: string): void {
	const graph = (JSON.parse(readFileSync(source, "utf8")) as { "@graph": VocabularyNode[] })[
		"@graph"
	];
	const types: Record<string, string[]> = {};
	const members: Record<string, string[]> = {};
	const properties: Record<string, [string[], string[]]> = {};
	const superseded: Record<string, string> = {};
	for (const node of graph) {
		if (!node["@id"].startsWith("schema:")) continue;
		const name = node["@id"].slice("schema:".length);
		const kinds = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
		const replacement = names(node["schema:supersededBy"])[0];
		if (replacement !== undefined) superseded[name] = replacement;
		if (kinds.includes("rdf:Property")) {
			properties[name] = [
				names(node["schema:domainIncludes"]),
				names(node["schema:rangeIncludes"])
			];
		} else if (kinds.includes("rdfs:Class")) {
			types[name] = names(node["rdfs:subClassOf"]);
		} else {
			const enumerations = kinds
				.filter((kind) => kind.startsWith("schema:"))
				.map((kind) => kind.slice("schema:".length));
			if (enumerations.length > 0) members[name] = enumerations.sort();
		}
	}
	const sorted = <Value>(record: Record<string, Value>): Record<string, Value> =>
		Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
	const table = {
		source: `https://schema.org/version/${version}/schemaorg-current-https.jsonld`,
		version,
		retrieved: new Date().toISOString().slice(0, 10),
		types: sorted(types),
		members: sorted(members),
		properties: sorted(properties),
		superseded: sorted(superseded)
	};
	const target = resolve(packageDir, "src/schema-vocabulary.json");
	writeFileSync(target, `${JSON.stringify(table)}\n`);
	console.log(
		`[schema] ${String(Object.keys(types).length)} types, ${String(Object.keys(properties).length)} properties, ${String(Object.keys(members).length)} enumeration members -> ${target}`
	);
}

const [source, version] = process.argv.slice(2);
if (source === undefined || version === undefined) {
	console.error("usage: build-schema-vocabulary.ts <schemaorg-current-https.jsonld> <version>");
	process.exit(1);
}
main(source, version);
