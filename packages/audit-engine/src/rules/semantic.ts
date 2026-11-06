import { finding, indexableSnapshot } from "./page-state";
import type { AuditContext, AuditFinding } from "./types";

/**
 * THE MEANING RULE: pages off the site's topic (`low_relevance`). Pages written for the same intent
 * have one home, the Command center's Competing pages lens, never filed here too.
 *
 * - `low_relevance` (an insight) reads the pages' meaning embeddings, made only when the project
 *   switched its semantic checks on (each charged to its payer): a page whose meaning is far from the
 *   site's average, {@link LOW_RELEVANCE_Z} standard deviations below the site's pages, at most the
 *   {@link LOW_RELEVANCE_SHARE} farthest, and only on a site with {@link LOW_RELEVANCE_MIN_PAGES}
 *   embedded pages or more.
 */

/** The fewest embedded pages before a page is judged off the site's topic. */
export const LOW_RELEVANCE_MIN_PAGES = 20;

/** How many standard deviations below the site's pages a page's similarity must fall. */
export const LOW_RELEVANCE_Z = 2.5;

/** The largest share of the embedded pages ever filed. */
export const LOW_RELEVANCE_SHARE = 0.05;

/**
 * A vector scaled to length one, or null for a zero vector.
 *
 * @param vector - The vector.
 * @returns The unit vector, or null.
 */
function unit(vector: Float32Array): Float32Array | null {
	let sum = 0;
	for (const value of vector) sum += value * value;
	const length = Math.sqrt(sum);
	if (!(length > 0)) return null;
	return vector.map((value) => value / length);
}

/**
 * The off-topic findings: pages whose meaning is far from the site's average.
 *
 * @param context - The audit.
 * @returns The findings.
 */
function relevanceFindings(context: AuditContext): AuditFinding[] {
	const embeddings = context.site.embeddings ?? null;
	if (embeddings === null) return [];
	const vectors: { pageKey: string; vector: Float32Array }[] = [];
	for (const page of context.pages) {
		const stored = embeddings.get(page.pageKey);
		if (stored === undefined || indexableSnapshot(page, context) === null) continue;
		const vector = unit(stored);
		if (vector !== null) vectors.push({ pageKey: page.pageKey, vector });
	}
	const size = vectors[0]?.vector.length ?? 0;
	if (vectors.length < LOW_RELEVANCE_MIN_PAGES || size === 0) return [];
	const centroid = new Float32Array(size);
	for (const { vector } of vectors) {
		if (vector.length !== size) return [];
		for (let index = 0; index < size; index += 1)
			centroid[index] = (centroid[index] ?? 0) + (vector[index] ?? 0);
	}
	const center = unit(centroid);
	if (center === null) return [];
	const scored = vectors.map(({ pageKey, vector }) => {
		let dot = 0;
		for (let index = 0; index < size; index += 1)
			dot += (vector[index] ?? 0) * (center[index] ?? 0);
		return { pageKey, score: dot };
	});
	const mean = scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length;
	const deviation = Math.sqrt(
		scored.reduce((sum, entry) => sum + (entry.score - mean) ** 2, 0) / scored.length
	);
	if (!(deviation > 0)) return [];
	const most = Math.floor(scored.length * LOW_RELEVANCE_SHARE);
	return scored
		.filter((entry) => (entry.score - mean) / deviation <= -LOW_RELEVANCE_Z)
		.sort((left, right) => left.score - right.score)
		.slice(0, most)
		.map((entry) =>
			finding(entry.pageKey, "low_relevance", { score: Math.round(entry.score * 100) / 100 })
		);
}

/**
 * The meaning findings of the site.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function semanticFindings(context: AuditContext): AuditFinding[] {
	return relevanceFindings(context);
}
