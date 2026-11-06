import { finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditSitePage } from "./types";

/**
 * THE SPELLING RULES: the words a page's language's dictionary did not know (`../spelling`), judged
 * across the whole site so a term of the site is never a typo.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a word several pages share ({@link SITE_TERM_PAGES} or more) is the site's own vocabulary (a
 *   product, a brand, a field's jargon) and is dropped everywhere; so is a word of the site's own host
 *   name;
 * - unknown words in the main text are an insight (`spelling_errors`): a dictionary cannot know every
 *   name, so the list is a fact to look through, never counted as an issue;
 * - an unknown word in the title or the H1 that the page's text never uses and its address does not
 *   repeat (`spelling_in_title`) is a notice: it shows in search results and on top of the page.
 * Only 2xx HTML pages whose reading ran the check are judged.
 */

/** A word on this many pages or more is the site's own term, never a typo. */
const SITE_TERM_PAGES = 3;

/** The most words a finding names. */
const WORDS_SHOWN = 10;

/**
 * The words of the site's host name (`shop.acme-store.com`: `shop`, `acme`, `store`).
 *
 * @param homeKey - The home page key, or null.
 * @returns The words, lowercased.
 */
function hostWords(homeKey: string | null): Set<string> {
	const host = (homeKey ?? "").split("/")[0] ?? "";
	return new Set(
		host
			.toLowerCase()
			.split(/[.-]/u)
			.filter((word) => word.length >= 3)
	);
}

/**
 * The words of a page's address path (`/changelog/` and `/docs/web-hooks`: `changelog`, `docs`, `web`,
 * `hooks`, `webhooks`): a heading word the address repeats was chosen on purpose, never a typo.
 *
 * @param pageKey - The page key.
 * @returns The words, lowercased.
 */
function slugWords(pageKey: string): Set<string> {
	const path = pageKey.slice(pageKey.indexOf("/") + 1).toLowerCase();
	const words = new Set<string>();
	for (const segment of path.split(/[/?#&=.]/u)) {
		const parts = segment.split(/[-_+]/u).filter((part) => part !== "");
		for (const part of parts) words.add(part);
		if (parts.length > 1) words.add(parts.join(""));
	}
	return words;
}

/**
 * Every unknown word of one page, once.
 *
 * @param page - The page.
 * @returns The words.
 */
function pageWords(page: AuditSitePage): Set<string> {
	const spelling = page.facts?.checks?.spelling;
	if (spelling == null) return new Set();
	return new Set([...spelling.text.map((entry) => entry.word), ...spelling.title, ...spelling.h1]);
}

/**
 * The spelling findings of the site.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function spellingFindings(context: AuditContext): AuditFinding[] {
	const judged = context.pages.filter(
		(page) => page.facts?.checks?.spelling != null && htmlSnapshot(page) !== null
	);
	if (judged.length === 0) return [];
	const pagesOf = new Map<string, number>();
	for (const page of context.pages)
		for (const word of pageWords(page)) pagesOf.set(word, (pagesOf.get(word) ?? 0) + 1);
	const host = hostWords(context.site.homeKey);
	const typo = (word: string): boolean =>
		(pagesOf.get(word) ?? 0) < SITE_TERM_PAGES && !host.has(word);
	const found: AuditFinding[] = [];
	for (const page of judged) {
		const spelling = page.facts?.checks?.spelling;
		if (spelling == null) continue;
		const text = spelling.text.filter((entry) => typo(entry.word));
		if (text.length > 0) {
			found.push(
				finding(page.pageKey, "spelling_errors", {
					count: text.length,
					words: text.slice(0, WORDS_SHOWN).map((entry) => entry.word)
				})
			);
		}
		const slug = slugWords(page.pageKey);
		const heading = [...new Set([...spelling.title, ...spelling.h1])].filter(
			(word) => typo(word) && !slug.has(word)
		);
		if (heading.length > 0) {
			found.push(
				finding(page.pageKey, "spelling_in_title", { words: heading.slice(0, WORDS_SHOWN) })
			);
		}
	}
	return found;
}
