/**
 * LINK SCORE: every crawled page's internal PageRank, 0 to 100, computed once per audit over the stored
 * link graph. A metric for ordering pages (which matter most to the site's own linking), never an issue.
 *
 * The model is the classic one: damping 0.85; each link a page holds takes an equal share of its rank;
 * a `rel="nofollow"` link, a link on a page that asks crawlers not to follow its links, and a link to
 * a URL the crawl did not read take their share and pass it to nobody (it evaporates, as it does for
 * search engines); a page with no links at all hands its rank to every page evenly. A link's target is
 * taken where it lands after the known redirects and variants.
 *
 * The raw ranks are put on a log scale: 100 for the page with the most, 0 for the least any page can
 * hold (the share every page gets without a single link passing it anything). PURE, and linear in the links per
 * iteration over typed arrays, so a graph of 100,000 pages and millions of links scores in seconds.
 */

import { LinkGraph, linkGraphOf } from "./link-graph";

/** One internal link as the score reads it. */
export interface SeoScoreLink {
	sourceKey: string;
	targetKey: string;
	nofollow: boolean;
}

/** The share of rank passed along links (the rest is spread evenly). */
const DAMPING = 0.85;

/** Iterations at most. */
const MAX_ITERATIONS = 100;

/** The total change in rank under which the iteration has settled. */
const TOLERANCE = 1e-9;

/**
 * Every page's Link Score.
 *
 * @param pageKeys - The crawled pages that answered with a page of their own (redirects left out).
 * @param links - The internal links: the audit's link graph (`./link-graph`), or a list.
 * @param resolve - The page a key lands on after known redirects and variants (a graph given whole
 *   was built with it already).
 * @param unfollowed - The pages that ask crawlers not to follow any of their links.
 * @returns Page key to its score, 0 to 100.
 */
export function linkScores(
	pageKeys: readonly string[],
	links: LinkGraph | readonly SeoScoreLink[],
	resolve: (key: string) => string = (key) => key,
	unfollowed: ReadonlySet<string> = new Set()
): Map<string, number> {
	const graph = links instanceof LinkGraph ? links : linkGraphOf(links, resolve);
	const index = new Map<string, number>();
	for (const key of pageKeys) if (!index.has(key)) index.set(key, index.size);
	const count = index.size;
	const scores = new Map<string, number>();
	if (count === 0) return scores;

	const nodeOf = new Int32Array(graph.keyCount).fill(-1);
	const silent = new Uint8Array(graph.keyCount);
	for (let id = 0; id < graph.keyCount; id += 1) {
		const key = graph.keys[id] ?? "";
		nodeOf[id] = index.get(key) ?? -1;
		if (unfollowed.has(key)) silent[id] = 1;
	}
	const outDegree = new Float64Array(count);
	const edgeSources = new Int32Array(graph.length);
	const edgeTargets = new Int32Array(graph.length);
	let edges = 0;
	for (let link = 0; link < graph.length; link += 1) {
		const sourceId = graph.sourceOf(link);
		const landingSource = graph.landing(sourceId);
		const source = nodeOf[landingSource] ?? -1;
		if (source === -1) continue;
		const landingTarget = graph.landing(graph.targetOf(link));
		if (landingTarget === landingSource) continue;
		outDegree[source] = (outDegree[source] ?? 0) + 1;
		if (graph.nofollow(link) || silent[sourceId] === 1 || silent[landingSource] === 1) continue;
		const target = nodeOf[landingTarget] ?? -1;
		if (target === -1) continue;
		edgeSources[edges] = source;
		edgeTargets[edges] = target;
		edges += 1;
	}
	const from = edgeSources.subarray(0, edges);
	const to = edgeTargets.subarray(0, edges);

	let rank = new Float64Array(count).fill(1 / count);
	let next = new Float64Array(count);
	const base = (1 - DAMPING) / count;
	for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
		let dangling = 0;
		for (let node = 0; node < count; node += 1) {
			if ((outDegree[node] ?? 0) === 0) dangling += rank[node] ?? 0;
		}
		next.fill(base + (DAMPING * dangling) / count);
		for (let edge = 0; edge < from.length; edge += 1) {
			const source = from[edge] ?? 0;
			const target = to[edge] ?? 0;
			next[target] =
				(next[target] ?? 0) + (DAMPING * (rank[source] ?? 0)) / (outDegree[source] ?? 1);
		}
		let change = 0;
		for (let node = 0; node < count; node += 1) {
			change += Math.abs((next[node] ?? 0) - (rank[node] ?? 0));
		}
		[rank, next] = [next, rank];
		if (change < TOLERANCE) break;
	}

	let max = 0;
	let dangling = 0;
	for (let node = 0; node < count; node += 1) {
		const value = rank[node] ?? 0;
		if (value > max) max = value;
		if ((outDegree[node] ?? 0) === 0) dangling += value;
	}
	const floor = base + (DAMPING * dangling) / count;
	const span = Math.log(max / floor);
	for (const [key, node] of index) {
		const value = rank[node] ?? floor;
		const score = span <= 0 ? 100 : (100 * Math.log(Math.max(value, floor) / floor)) / span;
		scores.set(key, Math.max(0, Math.min(100, Math.round(score))));
	}
	return scores;
}
