import { landingKey, linksFrom, robotsDisallowed } from "./lookups";
import {
	brokenStatus,
	canonicalKey,
	crawlBlocked,
	finding,
	htmlSnapshot,
	noindexOf
} from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditSitePage } from "./types";

/**
 * THE PAGINATION AND AMP RULES: how a paginated series and an AMP page point at each other. Read from
 * the `rel="next"`, `rel="prev"` and `rel="amphtml"` links of the page as stored and the pages they
 * name, each judged only once the crawler read it.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - Google no longer reads `rel="next"` and `rel="prev"`, so a broken series is an insight; what
 *   still matters is that the pages are linked with real links and that page 2 onward is not
 *   canonicalised to page 1 (the items deeper in the series are then never indexed);
 * - an AMP page that names itself canonical is a standalone AMP page (valid); an AMP page is filed
 *   only when its canonical is missing, is another AMP page, or cannot be indexed;
 * - a target the site refused the crawler (403, 429, bot wall) is never called broken.
 */

/** The page number a URL key states (`?page=3`, `/page/3`), or null when it states none. */
const PAGE_PARAM = /[?&](?:page|pg|paged)=(\d+)(?:&|$)/i;

/** A `/page/3` path segment. */
const PAGE_PATH = /\/page\/(\d+)(?=\/|\?|$)/i;

/**
 * The page number a key states (`?page=3`, `/page/3`), or null.
 *
 * @param key - The page key.
 * @returns The number, or null.
 */
export function pageNumber(key: string): number | null {
	const match = PAGE_PARAM.exec(key) ?? PAGE_PATH.exec(key);
	return match === null ? null : Number.parseInt(match[1] ?? "", 10);
}

/**
 * The key of a series' first page: the key with its page number taken out (a key without one is its
 * own first page).
 *
 * @param key - A page key of the series.
 * @returns The first page's key.
 */
export function firstPageKey(key: string): string {
	return key
		.replace(PAGE_PATH, "")
		.replace(/([?&])(?:page|pg|paged)=\d+(&|$)/i, (_, lead: string, tail: string) =>
			lead === "?" && tail === "&" ? "?" : tail === "&" ? lead : ""
		)
		.replace(/[?&]$/, "");
}

/**
 * Whether a page read from its HTML can be indexed: a 2xx HTML page without noindex.
 *
 * @param page - The page.
 * @returns Whether it can.
 */
function indexable(page: AuditSitePage): boolean {
	const snapshot = htmlSnapshot(page);
	return snapshot !== null && snapshot.mode !== "rendered" && !noindexOf(snapshot);
}

/**
 * The pagination findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
function paginationFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const markup = page.facts?.markup ?? null;
	const key = page.pageKey;
	const self = context.resolve(key);
	const found: AuditFinding[] = [];
	const next = markup?.pagination.next ?? [];
	const prev = markup?.pagination.prev ?? [];

	const number = pageNumber(key);
	const deep = prev.length > 0 || (number !== null && number >= 2);
	const target = canonicalKey(page, context);
	if (deep && target !== null && target !== self) {
		const first = context.resolve(firstPageKey(key));
		const named = context.byKey.get(target);
		const namedPrev = named?.facts?.markup?.pagination.prev ?? null;
		const isFirst =
			target === first ||
			(namedPrev !== null &&
				namedPrev.length === 0 &&
				(named?.facts?.markup?.pagination.next.length ?? 0) > 0);
		if (isFirst) found.push(finding(key, "paginated_canonical_to_first", { target }));
	}

	const series = [...next, ...prev];
	if (series.length === 0) return found;
	const linked = new Set(
		(linksFrom(context).get(key) ?? []).map(
			(link) => link.resolvedKey ?? context.resolve(link.targetKey)
		)
	);
	const unlinked = series
		.map((url) => landingKey(url, context))
		.filter((landing): landing is string => landing !== null && landing !== self)
		.filter((landing) => context.byKey.has(landing) && !linked.has(landing));
	if (unlinked.length > 0) {
		found.push(finding(key, "pagination_not_linked", { urls: [...new Set(unlinked)] }));
	}

	const kinds = new Set<string>();
	if (next.length > 1 || prev.length > 1) kinds.add("several");
	for (const url of series) {
		const landing = landingKey(url, context);
		if (landing === null) continue;
		if (landing === self) {
			kinds.add("loop");
			continue;
		}
		const linkedPage = context.byKey.get(landing);
		if (linkedPage === undefined || crawlBlocked(linkedPage)) continue;
		const status = linkedPage.status ?? linkedPage.snapshot?.status ?? null;
		if (status !== null && (status < 200 || status >= 300)) kinds.add("not_ok");
	}
	if (kinds.size > 0) {
		found.push(finding(key, "pagination_invalid", { kinds: [...kinds], kind: [...kinds][0] }));
	}
	return found;
}

/**
 * The AMP findings of one page: of a page naming its AMP version, and of an AMP page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
function ampFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const markup = page.facts?.markup ?? null;
	if (markup === null) return [];
	const key = page.pageKey;
	const self = context.resolve(key);
	const found: AuditFinding[] = [];

	const ampUrl = markup.amp.isAmp ? null : markup.amp.amphtml;
	const ampKey = ampUrl === null ? null : landingKey(ampUrl, context);
	if (ampKey !== null && ampKey !== self) {
		const amp = context.byKey.get(ampKey);
		let problem: string | null = null;
		if (robotsDisallowed(ampKey, context)) problem = "disallowed";
		else if (amp !== undefined && !crawlBlocked(amp) && amp.lastError === null) {
			const status = amp.status ?? amp.snapshot?.status ?? null;
			if (brokenStatus(status)) problem = "error";
			else if (status !== null && status >= 300 && status < 400) problem = "redirect";
			else if (htmlSnapshot(amp) !== null && !indexable(amp)) problem = "noindex";
		}
		if (problem !== null) {
			found.push(finding(key, "amp_status_error", { kind: problem, target: ampKey }));
		}
	}

	if (markup.amp.isAmp && htmlSnapshot(page) !== null) {
		const canonical = canonicalKey(page, context);
		let problem: string | null = null;
		const target = canonical === null ? undefined : context.byKey.get(canonical);
		if (canonical === null) problem = "missing";
		else if (canonical !== self && target !== undefined && !crawlBlocked(target)) {
			if (target.facts?.markup?.amp.isAmp === true) problem = "to_amp";
			else if (htmlSnapshot(target) !== null && !indexable(target)) problem = "not_indexable";
			else if (brokenStatus(target.status ?? target.snapshot?.status ?? null)) {
				problem = "not_indexable";
			}
		}
		if (problem !== null) {
			found.push(
				finding(key, "amp_canonical_invalid", {
					kind: problem,
					...(canonical === null ? {} : { target: canonical })
				})
			);
		}
		if (
			canonical !== null &&
			canonical !== self &&
			target !== undefined &&
			indexable(target) &&
			target.facts?.markup != null &&
			target.facts.markup.amp.isAmp === false
		) {
			const back = target.facts.markup.amp.amphtml;
			const backKey = back === null ? null : landingKey(back, context);
			if (backKey !== self) {
				found.push(finding(canonical, "amp_missing_return_link", { amp: key }));
			}
		}
	}
	return found;
}

/**
 * The pagination and AMP findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function seriesFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	if (crawlBlocked(page) || htmlSnapshot(page) === null) return [];
	return [...paginationFindings(page, context), ...ampFindings(page, context)];
}
