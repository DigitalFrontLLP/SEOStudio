import { sameLanguage } from "../language";
import { signatureBands, signatureSimilarity } from "../minhash";
import { SEO_AUDIT_THRESHOLD_SPECS } from "../thresholds";

/**
 * NEAR-DUPLICATE PAGES: pages whose main texts overlap by at least {@link NEAR_DUPLICATE_THRESHOLD},
 * judged from their MinHash signatures (`../minhash`), so the texts themselves are never held.
 *
 * Built for sites of any size, never comparing every pair: identical signatures are grouped first,
 * then each band of every signature buckets the pages, and a page is compared only with the first few
 * pages of each bucket it falls in (those already grouped with it are skipped). Pages that match are
 * joined into groups, so a template copied onto thousands of pages costs about one comparison a page.
 * A page's near-duplicates are the rest of its group, less the pages with the very same text (filed as
 * exact duplicates), the pages it must not be compared with, and the pages declaring another language
 * for themselves in hreflang (language versions, judged by the translation checks), counted per group
 * without walking the group once per page. Pure.
 */

/** The minimum similarity of two near-duplicate texts. */
export const NEAR_DUPLICATE_THRESHOLD = SEO_AUDIT_THRESHOLD_SPECS.nearDuplicatePercent.value / 100;

/** The pages of one bucket a page is compared with before it is left to the other bands. */
const BUCKET_LEADERS = 8;

/** The group members scored for a page's examples. */
const EXAMPLE_POOL = 20;

/** One page entering near-duplicate detection. */
export interface DupPage {
	pageKey: string;
	signature: Uint32Array;
	/** The signature as stored: identical texts share it. */
	stored: string;
	/** The hash of its normalized main text: pages sharing it are exact duplicates, not near ones. */
	textHash: string;
	/** The language the page declares for itself in hreflang, or "" when it declares none. */
	language?: string;
}

/** One page's near-duplicates: how many, and the likeliest few with their similarity. */
export interface NearDuplicate {
	pageKey: string;
	count: number;
	partners: { pageKey: string; score: number }[];
	/** The near-duplicate group the page belongs to: pages sharing it are one text, nearly. */
	cluster: number;
}

/**
 * Groups items that match, joined transitively (union-find with path halving).
 *
 * @param size - How many items.
 * @returns `find` and `union` over item indices.
 */
function unionFind(size: number): {
	find: (index: number) => number;
	union: (left: number, right: number) => void;
} {
	const parent = Array.from({ length: size }, (_, index) => index);
	const find = (index: number): number => {
		let current = index;
		while (parent[current] !== current) {
			const up = parent[current] ?? current;
			parent[current] = parent[up] ?? up;
			current = parent[current] ?? current;
		}
		return current;
	};
	const union = (left: number, right: number): void => {
		const a = find(left);
		const b = find(right);
		if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
	};
	return { find, union };
}

/**
 * Whether two pages declare different languages for themselves in hreflang: language versions of one
 * text, never each other's duplicates. A page declaring none is compared with every page.
 *
 * @param left - One page's own hreflang language, or "".
 * @param right - The other's, or "".
 * @returns Whether they are apart.
 */
export function languagesApart(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined || left === "" || right === "") return false;
	return !sameLanguage(left, right);
}

/**
 * Adds an item to the list under a key.
 *
 * @param lists - The lists.
 * @param key - The key.
 * @param item - The item.
 */
function push<K, V>(lists: Map<K, V[]>, key: K, item: V): void {
	const list = lists.get(key);
	if (list === undefined) lists.set(key, [item]);
	else list.push(item);
}

/**
 * The near-duplicate findings of one group of matching pages.
 *
 * @param pages - Every page.
 * @param group - The indices of one group's pages.
 * @param apart - The pages each page must not be compared with, by key.
 * @returns The group's findings.
 */
function groupFindings(
	pages: readonly DupPage[],
	group: readonly number[],
	apart: ReadonlyMap<string, ReadonlySet<string>>
): Omit<NearDuplicate, "cluster">[] {
	const byHash = new Map<string, number[]>();
	const ordered = [...group].sort((left, right) =>
		(pages[left]?.pageKey ?? "").localeCompare(pages[right]?.pageKey ?? "")
	);
	for (const index of ordered) push(byHash, pages[index]?.textHash ?? "", index);
	if (byHash.size < 2) return [];
	const hashOf = new Map(group.map((index) => [pages[index]?.pageKey, pages[index]?.textHash]));
	const languageOf = new Map(group.map((index) => [pages[index]?.pageKey, pages[index]?.language]));
	const languages = new Map<string, { pages: number; byHash: Map<string, number> }>();
	for (const index of group) {
		const member = pages[index];
		const language = member?.language ?? "";
		if (member === undefined || language === "") continue;
		const counts = languages.get(language) ?? { pages: 0, byHash: new Map<string, number>() };
		counts.pages += 1;
		counts.byHash.set(member.textHash, (counts.byHash.get(member.textHash) ?? 0) + 1);
		languages.set(language, counts);
	}
	const hashes = [...byHash.keys()].sort();
	const found: Omit<NearDuplicate, "cluster">[] = [];
	for (const index of group) {
		const page = pages[index];
		if (page === undefined) continue;
		const kept = apart.get(page.pageKey) ?? new Set<string>();
		let excluded = byHash.get(page.textHash)?.length ?? 0;
		for (const [language, counts] of languages) {
			if (languagesApart(page.language, language))
				excluded += counts.pages - (counts.byHash.get(page.textHash) ?? 0);
		}
		for (const other of kept) {
			const hash = hashOf.get(other);
			if (
				hash !== undefined &&
				hash !== page.textHash &&
				!languagesApart(page.language, languageOf.get(other))
			)
				excluded += 1;
		}
		const count = group.length - excluded;
		if (count <= 0) continue;
		const pool: { pageKey: string; score: number }[] = [];
		for (const hash of hashes) {
			if (hash === page.textHash) continue;
			for (const other of byHash.get(hash) ?? []) {
				const candidate = pages[other];
				if (
					candidate === undefined ||
					kept.has(candidate.pageKey) ||
					languagesApart(page.language, candidate.language)
				)
					continue;
				pool.push({
					pageKey: candidate.pageKey,
					score: signatureSimilarity(page.signature, candidate.signature)
				});
				if (pool.length >= EXAMPLE_POOL) break;
			}
			if (pool.length >= EXAMPLE_POOL) break;
		}
		pool.sort(
			(left, right) => right.score - left.score || left.pageKey.localeCompare(right.pageKey)
		);
		found.push({ pageKey: page.pageKey, count, partners: pool });
	}
	return found;
}

/**
 * Every page with at least one near-duplicate.
 *
 * @param pages - The pages, each with its signature and text hash.
 * @param apart - The pages each page must never be called a duplicate of (its language versions), by key.
 * @param similarity - The overlap from which two texts are near-duplicates (a project may change it:
 *   `../thresholds`).
 * @returns The pages with near-duplicates, in input order.
 */
export function nearDuplicates(
	pages: readonly DupPage[],
	apart: ReadonlyMap<string, ReadonlySet<string>>,
	similarity: number = NEAR_DUPLICATE_THRESHOLD
): NearDuplicate[] {
	const repOf = new Map<string, number>();
	const reps: number[] = [];
	const memberRep = pages.map((page, index) => {
		const known = repOf.get(page.stored);
		if (known !== undefined) return known;
		repOf.set(page.stored, reps.length);
		reps.push(index);
		return reps.length - 1;
	});
	const groups = unionFind(reps.length);
	const buckets = new Map<number, number[]>();
	reps.forEach((pageIndex, rep) => {
		const signature = pages[pageIndex]?.signature;
		if (signature === undefined) return;
		signatureBands(signature).forEach((bucket, band) => {
			const key = bucket * 32 + band;
			const leaders = buckets.get(key) ?? [];
			let matched = false;
			for (const leader of leaders) {
				if (groups.find(leader) === groups.find(rep)) {
					matched = true;
					break;
				}
				const other = pages[reps[leader] ?? -1]?.signature;
				if (other !== undefined && signatureSimilarity(signature, other) >= similarity) {
					groups.union(leader, rep);
					matched = true;
					break;
				}
			}
			if (!matched && leaders.length < BUCKET_LEADERS) buckets.set(key, [...leaders, rep]);
		});
	});

	const members = new Map<number, number[]>();
	pages.forEach((_, index) => push(members, groups.find(memberRep[index] ?? 0), index));
	const found: NearDuplicate[] = [];
	for (const [cluster, group] of members) {
		if (group.length < 2) continue;
		for (const entry of groupFindings(pages, group, apart)) found.push({ ...entry, cluster });
	}
	const order = new Map(pages.map((page, index) => [page.pageKey, index]));
	return found.sort(
		(left, right) => (order.get(left.pageKey) ?? 0) - (order.get(right.pageKey) ?? 0)
	);
}

/** The values in one band when pages are bucketed for containment: shorter bands bucket less alike pairs. */
const CONTAINED_BAND_ROWS = 4;

/** The pages of one containment bucket a page is compared with. */
const CONTAINED_BUCKET_LEADERS = 16;

/** One page entering containment detection. */
export interface ContainPage {
	pageKey: string;
	signature: Uint32Array;
	/** The words of its main text. */
	words: number;
}

/** A page whose main text sits, nearly whole, inside a longer page's. */
export interface ContainedPair {
	/** The shorter page, whose text is inside the other. */
	inner: string;
	/** The longer page, which holds it. */
	outer: string;
	/** The share of the shorter page's text the longer one holds, 0 to 1. */
	share: number;
}

/**
 * The share of the shorter text inside the longer one, estimated from their MinHash similarity (the
 * overlap over the union of their word three-grams) and their lengths: the overlap is the similarity
 * times the sum of both sizes over one plus the similarity, and the share is that overlap over the
 * shorter text's size.
 *
 * @param similarity - The two signatures' similarity.
 * @param left - One text's words.
 * @param right - The other's.
 * @returns 0 to 1.
 */
export function containedShare(similarity: number, left: number, right: number): number {
	const one = Math.max(left - 2, 1);
	const two = Math.max(right - 2, 1);
	const overlap = (similarity * (one + two)) / (1 + similarity);
	return Math.min(1, overlap / Math.min(one, two));
}

/**
 * PAGES CONTAINED IN ANOTHER: pairs where at least `share` of the shorter page's main text sits inside
 * the longer one's ({@link containedShare}), which overlap alone misses when the longer page adds text
 * of its own. Never compares every pair: each page is bucketed by short bands of its signature and
 * compared with the first few pages of each bucket it falls in. Pure.
 *
 * @param pages - The pages to compare.
 * @param skip - Whether a pair is never compared (already near-duplicates, the very same text, language versions).
 * @param share - The share of the shorter text from which it is contained.
 * @returns Each contained pair once.
 */
export function containedPairs(
	pages: readonly ContainPage[],
	skip: (left: string, right: string) => boolean,
	share: number
): ContainedPair[] {
	const buckets = new Map<number, number[]>();
	const found: ContainedPair[] = [];
	pages.forEach((page, index) => {
		const checked = new Set<number>();
		signatureBands(page.signature, CONTAINED_BAND_ROWS).forEach((bucket, band) => {
			const key = bucket * 64 + band;
			const leaders = buckets.get(key) ?? [];
			for (const leader of leaders) {
				const other = pages[leader];
				if (other === undefined || checked.has(leader)) continue;
				checked.add(leader);
				if (skip(page.pageKey, other.pageKey)) continue;
				const similarity = signatureSimilarity(page.signature, other.signature);
				const inside = containedShare(similarity, page.words, other.words);
				if (inside < share) continue;
				const pageShorter =
					page.words < other.words || (page.words === other.words && page.pageKey < other.pageKey);
				found.push({
					inner: pageShorter ? page.pageKey : other.pageKey,
					outer: pageShorter ? other.pageKey : page.pageKey,
					share: inside
				});
			}
			if (leaders.length < CONTAINED_BUCKET_LEADERS) buckets.set(key, [...leaders, index]);
		});
	});
	return found;
}
