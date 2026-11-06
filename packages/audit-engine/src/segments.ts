import type { SeoCrawlSegment } from "./facts";

import { compileRobotsPattern, robotsPatternMatches } from "./robots";
import { urlPattern } from "./templates";

/**
 * SEGMENTS AND SAMPLING, as pure rules over page keys (`host/path?query`).
 *
 * A SEGMENT is a member's named group of URL patterns (`/blog/`, `*\/product/*`, `?color=`), written
 * like the include and exclude patterns: robots.txt-style (`*` any characters, `$` the end) and matched
 * against the path and query; a pattern that starts with neither `/` nor `*` matches anywhere in it.
 * The audit's issues and pages are filtered by one. The database filters with the regular expression
 * {@link segmentRegex} builds, which matches exactly what {@link segmentMatches} matches.
 *
 * SAMPLING keeps a big site's crawl to a few pages of each URL pattern (`host/blog/*`, the same
 * pattern the page templates group by), pages with search traffic always kept. The same patterns keep
 * a plan's analytics-only pages to a few of each ({@link analyticsSeedKeys}).
 *
 * NOINDEX FAMILIES: pages that share one path but for an id segment (`/orders/1042`, `/u/9f3c2a71...`)
 * are one family ({@link idFamilyOf}). Once the crawl has read a few pages of a family and every one
 * says `noindex` ({@link inNoindexFamily}), each crawl reads a ROTATING SAMPLE of it, the pages read
 * least recently first ({@link familyRotation}): a site's thousands of noindex pages built from one
 * template (orders, profiles, carts, results) cost a few fetches a crawl, and over the weeks every
 * page is looked at.
 */

/**
 * A member's pattern as robots.txt reads it: one that starts with neither `/` nor `*` is read as if it
 * started with `*`.
 *
 * @param pattern - The pattern as written.
 * @returns The pattern robots.txt-style.
 */
export function memberPatternText(pattern: string): string {
	return pattern.startsWith("/") || pattern.startsWith("*") ? pattern : `*${pattern}`;
}

/**
 * A key's path and query.
 *
 * @param pageKey - The page key.
 * @returns The path and query.
 */
function pathOf(pageKey: string): string {
	const slash = pageKey.indexOf("/");
	return slash === -1 ? "/" : pageKey.slice(slash);
}

/**
 * Whether a page belongs to a segment: one of its patterns matches the page's path and query.
 *
 * @param segment - The segment.
 * @param pageKey - The page key.
 * @returns Whether it matches.
 */
export function segmentMatches(segment: SeoCrawlSegment, pageKey: string): boolean {
	const target = pathOf(pageKey);
	return segment.patterns.some((pattern) =>
		robotsPatternMatches(compileRobotsPattern(memberPatternText(pattern)), target)
	);
}

/** The characters a POSIX-style regular expression gives a meaning. */
const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}]/g;

/**
 * A segment as ONE regular expression over a page key (Postgres `~`): the host, then the path and
 * query matched as robots.txt matches it (a prefix, `*` any characters, `$` the end).
 *
 * @param segment - The segment.
 * @returns The expression, or null when the segment has no pattern.
 */
export function segmentRegex(segment: SeoCrawlSegment): string | null {
	const alternatives = segment.patterns.map((pattern) => {
		const text = memberPatternText(pattern);
		const anchored = text.endsWith("$");
		const body = (anchored ? text.slice(0, -1) : text)
			.split("*")
			.map((part) => part.replace(REGEX_SPECIAL, "\\$&"))
			.join(".*");
		return anchored ? `${body}$` : body;
	});
	if (alternatives.length === 0) return null;
	return `^[^/]*(?:${alternatives.join("|")})`;
}

/**
 * The segment a member named, its name matched without regard to case.
 *
 * @param segments - The project's segments.
 * @param name - The name asked for, or null.
 * @returns The segment, or null when none has that name.
 */
export function findSegment(
	segments: readonly SeoCrawlSegment[],
	name: string | null | undefined
): SeoCrawlSegment | null {
	if (name == null || name.trim() === "") return null;
	const wanted = name.trim().toLowerCase();
	return segments.find((segment) => segment.name.toLowerCase() === wanted) ?? null;
}

/** One page as sampling reads it. */
export interface SeoSampleCandidate {
	pageKey: string;
	/** Whether the page is kept whatever its pattern holds (the home page, a page with search traffic). */
	keep: boolean;
}

/**
 * A crawl's pages SAMPLED: in their order, at most `perPattern` pages of one URL pattern, the pages
 * that must stay kept on top of it.
 *
 * @param pages - The pages, in the order the crawl takes them.
 * @param perPattern - The most pages of one pattern, or null for no sampling.
 * @param held - Pages of each pattern already counted (the ones a crawl holds); not changed.
 * @returns The pages kept, in order.
 */
export function samplePages<T extends SeoSampleCandidate>(
	pages: readonly T[],
	perPattern: number | null,
	held: ReadonlyMap<string, number> = new Map()
): T[] {
	if (perPattern === null) return [...pages];
	const counts = new Map(held);
	const kept: T[] = [];
	for (const page of pages) {
		const pattern = urlPattern(page.pageKey);
		const count = counts.get(pattern) ?? 0;
		if (!page.keep && count >= perPattern) continue;
		counts.set(pattern, count + 1);
		kept.push(page);
	}
	return kept;
}

/** One page Analytics counted visits on, as the plan's seeding reads it. */
export interface SeoAnalyticsSeed {
	pageKey: string;
	/** Sessions over the traffic window. */
	sessions: number;
	/** Whether another source names the page too (sitemap, search, backlinks, a followed link). */
	known: boolean;
}

/**
 * The Analytics pages a crawl plan takes: every page another source names too, and of the pages only
 * Analytics names, those with at least `minSessions` sessions, at most `perPattern` of one URL pattern
 * (only analytics-only pages count toward it), the most visited first. Rows naming one key are added
 * together first.
 *
 * @param rows - The Analytics pages.
 * @param limits - The least sessions and the most pages of one pattern.
 * @returns The keys taken, known pages first, then by sessions.
 */
export function analyticsSeedKeys(
	rows: readonly SeoAnalyticsSeed[],
	limits: { minSessions: number; perPattern: number }
): string[] {
	const byKey = new Map<string, SeoAnalyticsSeed>();
	for (const row of rows) {
		const held = byKey.get(row.pageKey);
		if (held === undefined) byKey.set(row.pageKey, { ...row });
		else {
			held.sessions += row.sessions;
			held.known ||= row.known;
		}
	}
	const pages = [...byKey.values()].sort(
		(left, right) => right.sessions - left.sessions || left.pageKey.localeCompare(right.pageKey)
	);
	const only = samplePages(
		pages
			.filter((page) => !page.known && page.sessions >= limits.minSessions)
			.map((page) => ({ pageKey: page.pageKey, keep: false })),
		limits.perPattern
	);
	return [
		...pages.filter((page) => page.known).map((page) => page.pageKey),
		...only.map((page) => page.pageKey)
	];
}

/**
 * A path segment that is an id: a number, or a hexadecimal token (a hash, a UUID) holding a digit.
 */
const ID_SEGMENT = /^(?:\d+|(?=[0-9a-f-]*\d)[0-9a-f][0-9a-f-]{7,})$/i;

/**
 * A page key's FAMILY: its host and path with every id segment as `{id}`, the query left out
 * (`host/orders/{id}`); null when no segment is an id (`host/blog/a-post` is no family).
 *
 * @param pageKey - The page key.
 * @returns The family, or null.
 */
export function idFamilyOf(pageKey: string): string | null {
	const path = pageKey.split(/[?#]/)[0] ?? pageKey;
	const parts = path.split("/");
	let ids = 0;
	const shaped = parts.map((part, index) => {
		if (index === 0 || !ID_SEGMENT.test(part)) return part;
		ids += 1;
		return "{id}";
	});
	return ids === 0 ? null : shaped.join("/");
}

/**
 * The part of a family's keys before its first id segment (`host/orders/`), which every page of the
 * family starts with.
 *
 * @param family - The family ({@link idFamilyOf}).
 * @returns The prefix.
 */
export function idFamilyPrefix(family: string): string {
	return family.slice(0, family.indexOf("{id}"));
}

/** One held page of a family, as the crawl judges the family. */
export interface SeoFamilyReading {
	pageKey: string;
	/** Whether the crawl has read it as a page (a 2xx answer). */
	fetched: boolean;
	/** Whether its latest read says `noindex`. */
	noindex: boolean;
	/** When the crawl last read it, or null before it did. */
	lastCrawledAt: Date | null;
	/** Whether it is on the schedule; absent reads as not. */
	scheduled?: boolean;
}

/** What the crawl holds of one family. */
export interface SeoFamilyState {
	/** Pages read as a page (a 2xx answer). */
	fetched: number;
	/** Of them, pages that say `noindex`. */
	noindex: number;
	/** Pages read since the crawl in progress started. */
	readSince: number;
	/** Pages only known: never read and off the schedule, waiting for a turn. */
	waiting: number;
}

/**
 * The state of every family some held pages belong to.
 *
 * @param readings - The held pages.
 * @param since - When the crawl in progress started, or null.
 * @returns Each family's state.
 */
export function familyStates(
	readings: readonly SeoFamilyReading[],
	since: Date | null
): Map<string, SeoFamilyState> {
	const states = new Map<string, SeoFamilyState>();
	for (const reading of readings) {
		const family = idFamilyOf(reading.pageKey);
		if (family === null) continue;
		const state = states.get(family) ?? { fetched: 0, noindex: 0, readSince: 0, waiting: 0 };
		if (reading.lastCrawledAt === null && reading.scheduled !== true) state.waiting += 1;
		if (reading.fetched) {
			state.fetched += 1;
			if (reading.noindex) state.noindex += 1;
		}
		if (
			since !== null &&
			reading.lastCrawledAt !== null &&
			reading.lastCrawledAt.getTime() >= since.getTime()
		)
			state.readSince += 1;
		states.set(family, state);
	}
	return states;
}

/**
 * Whether a page belongs to a NOINDEX FAMILY: a family the crawl has read at least `judge` pages of,
 * every one saying `noindex`. Such a family is read as a rotating sample ({@link familyRotation}).
 *
 * @param states - Each family's state ({@link familyStates}).
 * @param judge - The pages of a family read before it is judged.
 * @param pageKey - The page.
 * @returns Whether it does.
 */
export function inNoindexFamily(
	states: ReadonlyMap<string, SeoFamilyState>,
	judge: number,
	pageKey: string
): boolean {
	const family = idFamilyOf(pageKey);
	const state = family === null ? undefined : states.get(family);
	return state !== undefined && state.fetched >= judge && state.noindex === state.fetched;
}

/**
 * Counts one read of a page in its family's state, when the family is held.
 *
 * @param states - Each family's state.
 * @param pageKey - The page read.
 * @param noindex - Whether the read says `noindex`.
 */
export function countFamilyRead(
	states: Map<string, SeoFamilyState>,
	pageKey: string,
	noindex: boolean
): void {
	const family = idFamilyOf(pageKey);
	const state = family === null ? undefined : states.get(family);
	if (state === undefined) return;
	state.fetched += 1;
	if (noindex) state.noindex += 1;
	state.readSince += 1;
}

/**
 * The next turn of a noindex family's ROTATING SAMPLE: the `size` pages read least recently, pages
 * never read first, so turn after turn every page of the family is looked at while each crawl reads
 * only a few.
 *
 * @param members - The family's pages.
 * @param size - The pages of one turn.
 * @returns Their keys.
 */
export function familyRotation(
	members: readonly { pageKey: string; lastCrawledAt: Date | null }[],
	size: number
): string[] {
	return [...members]
		.sort(
			(left, right) =>
				(left.lastCrawledAt?.getTime() ?? -1) - (right.lastCrawledAt?.getTime() ?? -1) ||
				left.pageKey.localeCompare(right.pageKey)
		)
		.slice(0, size)
		.map((member) => member.pageKey);
}

/**
 * How many of some pages each URL pattern holds.
 *
 * @param pageKeys - The pages.
 * @returns Pattern to its page count.
 */
export function patternCounts(pageKeys: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const key of pageKeys) {
		const pattern = urlPattern(key);
		counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
	}
	return counts;
}
