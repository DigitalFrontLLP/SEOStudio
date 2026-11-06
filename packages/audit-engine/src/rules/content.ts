import { primaryLanguage, sameLanguage } from "../language";
import {
	SERP_DESCRIPTION_FONT_PX,
	SERP_ESTIMATE_SLACK,
	SERP_TITLE_FONT_PX,
	serpPixelWidth,
	serpWidthEstimated
} from "../serp-width";
import { SEO_AUDIT_THRESHOLD_SPECS } from "../thresholds";
import type { SeoAuditThresholdValues } from "../thresholds";
import { finding, h1MissingOf, indexableSnapshot, isHome, thresholdsOf } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditSnapshot } from "./types";

/**
 * THE ON-PAGE CONTENT RULES: title, meta description, headings, text length, placeholder text and
 * language, all read from the page as stored (the rendered page whenever the browser rendered it).
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS: every rule here judges only a page search engines are asked to
 * show (2xx HTML read from its HTML, no noindex, canonical to itself), so a thank-you page, an
 * account page or a duplicate pointing its canonical elsewhere is never flagged for its title or its
 * text. Lengths are notices (a long title still ranks), measured in pixels as Google's results page
 * cuts them. A title or description that is only a placeholder ("TODO", "null", "Lorem ipsum") is a
 * warning instead of a length. "Little text" leaves out the home page and the pages that need little text by nature
 * (contact, sign-in, cart, search, legal). A text is called "in another language" only when the
 * detector rules the declared language out (`../language`): near-ties, mixed scripts and short texts
 * are never judged. A results page title is compared only once Google has had a week to read the
 * page's current title, and a site name Google adds or drops, or a title it cuts short, is not a
 * rewrite. A page is empty only when neither its HTML nor its render holds a word or an image (it is
 * then filed for that alone, never also for little text or a missing H1).
 */

/**
 * The thresholds the content rules use by default; a project may change the widths and the little
 * text count (`../thresholds`).
 */
export const CONTENT_THRESHOLDS = {
	/** Title width on Google's results page, in pixels: cut past the maximum. */
	titleMaxPx: SEO_AUDIT_THRESHOLD_SPECS.titleMaxPx.value,
	titleMinPx: SEO_AUDIT_THRESHOLD_SPECS.titleMinPx.value,
	/** Description width on Google's results page, in pixels. */
	descriptionMaxPx: SEO_AUDIT_THRESHOLD_SPECS.descriptionMaxPx.value,
	descriptionMinPx: SEO_AUDIT_THRESHOLD_SPECS.descriptionMinPx.value,
	thinWords: SEO_AUDIT_THRESHOLD_SPECS.thinWords.value,
	/** Days Google is given to read a page's current title before its results page title is compared. */
	serpTitleSettleDays: 7
} as const;

/** Path words of pages that need little text by nature (generic web conventions, any site). */
const LITTLE_TEXT_PATHS =
	/\/(?:contact|contact-us|login|log-in|signin|sign-in|signup|sign-up|register|account|cart|basket|checkout|search|privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|legal|imprint|impressum|cookies|cookie-policy|thank-you|thanks|unsubscribe|404)(?:[/?]|$)/i;

/**
 * The values a template or a script leaves where a title or a description was never written: a to-do
 * note, a programming language's empty value, the field's own name, or filler text. Compared as the
 * whole value, lowercased, with the punctuation and brackets around it dropped.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
	"todo",
	"null",
	"undefined",
	"description",
	"title",
	"lorem"
]);

/**
 * Whether a title or a description is only a placeholder ({@link PLACEHOLDER_VALUES}, or filler text
 * that starts "Lorem ipsum").
 *
 * @param value - The title or description.
 * @returns Whether it is.
 */
function metadataPlaceholder(value: string): boolean {
	const bare = value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
	return PLACEHOLDER_VALUES.has(bare) || bare.startsWith("lorem ipsum");
}

/** The separators a site name is joined to a title with, spaced on both sides. */
const TITLE_SEPARATOR = /\s+[-|–—·•:»]\s+/u;

/** A trailing cut mark on a results page title. */
const CUT_MARK = /\s*(?:\.\.\.|…)$/u;

/** The longest results page title kept in a finding. */
const SERP_TITLE_CHARS = 200;

/** A day in ms. */
const DAY_MS = 86_400_000;

/**
 * The first place the heading outline jumps down more than one level (H2 to H4), or null.
 *
 * @param levels - The heading levels in document order.
 * @returns The jump, or null.
 */
export function headingSkip(levels: readonly number[]): { from: number; to: number } | null {
	for (let index = 1; index < levels.length; index += 1) {
		const from = levels[index - 1] ?? 0;
		const to = levels[index] ?? 0;
		if (to > from + 1) return { from, to };
	}
	return null;
}

/**
 * Text as titles are compared: lowercased, Unicode-folded, whitespace collapsed.
 *
 * @param value - The text.
 * @returns The comparable form.
 */
function folded(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Whether Google's results page shows a title other than the page's own: a site name added, swapped
 * or dropped after a separator, or the title cut short, is the same title.
 *
 * @param pageTitle - The page's `<title>`.
 * @param serpTitle - The title the results page showed.
 * @returns Whether Google rewrote it.
 */
export function serpTitleRewritten(pageTitle: string, serpTitle: string): boolean {
	const own = folded(pageTitle);
	const cut = CUT_MARK.test(serpTitle.trim());
	const shown = folded(serpTitle.trim().replace(CUT_MARK, ""));
	if (own === "" || shown === "") return false;
	if (own === shown || own.includes(shown) || shown.includes(own)) return false;
	if (cut && own.startsWith(shown)) return false;
	const ownLead = own.split(TITLE_SEPARATOR)[0] ?? "";
	const shownLead = shown.split(TITLE_SEPARATOR)[0] ?? "";
	return ownLead !== shownLead && !(cut && ownLead.startsWith(shownLead));
}

/**
 * The language a page declares, as written: `<html lang>` of the stored page first.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns The tag, or "".
 */
function declaredLanguage(page: AuditPage, snapshot: AuditSnapshot): string {
	return (page.facts?.markup?.lang.html ?? page.facts?.page?.lang ?? snapshot.lang ?? "").trim();
}

/**
 * The title and length findings of a page's title and description.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @param t - The thresholds the audit judges with.
 * @returns The findings.
 */
function metadataFindings(
	page: AuditPage,
	snapshot: AuditSnapshot,
	t: SeoAuditThresholdValues
): AuditFinding[] {
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const markup = page.facts?.markup;

	const title = (snapshot.title ?? "").trim();
	if (title === "") found.push(finding(key, "title_missing"));
	else if (metadataPlaceholder(title))
		found.push(finding(key, "title_placeholder", { value: title }));
	else {
		const px = serpPixelWidth(title, SERP_TITLE_FONT_PX);
		const slack = serpWidthEstimated(title) ? SERP_ESTIMATE_SLACK : 0;
		if (px > t.titleMaxPx * (1 + slack))
			found.push(finding(key, "title_too_long", { px, max: t.titleMaxPx, length: title.length }));
		else if (px < t.titleMinPx * (1 - slack))
			found.push(finding(key, "title_too_short", { px, min: t.titleMinPx, length: title.length }));
	}
	if ((markup?.titles.length ?? 0) > 1)
		found.push(finding(key, "title_multiple", { count: markup?.titles.length ?? 0 }));

	const description = (snapshot.metaDescription ?? "").trim();
	if (description === "") found.push(finding(key, "meta_description_missing"));
	else if (metadataPlaceholder(description))
		found.push(finding(key, "meta_description_placeholder", { value: description }));
	else {
		const px = serpPixelWidth(description, SERP_DESCRIPTION_FONT_PX);
		const slack = serpWidthEstimated(description) ? SERP_ESTIMATE_SLACK : 0;
		if (px > t.descriptionMaxPx * (1 + slack))
			found.push(
				finding(key, "meta_description_too_long", {
					px,
					max: t.descriptionMaxPx,
					length: description.length
				})
			);
		else if (px < t.descriptionMinPx * (1 - slack))
			found.push(
				finding(key, "meta_description_too_short", {
					px,
					min: t.descriptionMinPx,
					length: description.length
				})
			);
	}
	if ((markup?.descriptions.length ?? 0) > 1)
		found.push(
			finding(key, "meta_description_multiple", { count: markup?.descriptions.length ?? 0 })
		);
	if (title !== "" && folded(title) === folded(description) && !metadataPlaceholder(title))
		found.push(finding(key, "title_same_as_description"));
	return found;
}

/**
 * The first results page title of a page that Google rewrote, read once Google had time to see the
 * page's current title.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns The finding, or null.
 */
function serpRewriteFinding(page: AuditPage, snapshot: AuditSnapshot): AuditFinding | null {
	const title = (snapshot.title ?? "").trim();
	const since = Date.parse(snapshot.fetchedAt ?? "");
	if (title === "" || Number.isNaN(since)) return null;
	const settled = since + CONTENT_THRESHOLDS.serpTitleSettleDays * DAY_MS;
	for (const shown of page.serpTitles ?? []) {
		const day = Date.parse(`${shown.day}T00:00:00Z`);
		if (Number.isNaN(day) || day < settled || !serpTitleRewritten(title, shown.title)) continue;
		return finding(page.pageKey, "title_serp_rewritten", {
			serpTitle: shown.title.trim().slice(0, SERP_TITLE_CHARS),
			keyword: shown.keyword
		});
	}
	return null;
}

/**
 * The language findings of a page: none declared, or a main text that clearly reads as another.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns The findings.
 */
function languageFindings(page: AuditPage, snapshot: AuditSnapshot): AuditFinding[] {
	const declared = declaredLanguage(page, snapshot);
	if (declared === "") return [finding(page.pageKey, "lang_missing")];
	const languages = page.facts?.text?.languages ?? null;
	if (languages === null || languages.length === 0) return [];
	if (!/^[a-z]{2,3}$/u.test(primaryLanguage(declared))) return [];
	if (languages.some((language) => sameLanguage(language, declared))) return [];
	return [finding(page.pageKey, "lang_body_mismatch", { declared, detected: languages[0] ?? "" })];
}

/**
 * The content findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function contentFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const snapshot = indexableSnapshot(page, context);
	if (snapshot === null) return [];
	const key = page.pageKey;
	const t = thresholdsOf(context);
	const found: AuditFinding[] = metadataFindings(page, snapshot, t);
	const rewrite = serpRewriteFinding(page, snapshot);
	if (rewrite !== null) found.push(rewrite);

	const h1Count = page.facts?.page?.h1Count ?? snapshot.h1Count ?? 0;
	const h1 = h1MissingOf(page, snapshot);
	if (h1.missing) found.push(finding(key, "h1_missing", h1.empty > 0 ? { empty: h1.empty } : {}));
	else if (h1Count > 1) found.push(finding(key, "h1_multiple", { count: h1Count }));

	const skip = headingSkip((snapshot.headings ?? []).map((heading) => heading.level));
	if (skip !== null) found.push(finding(key, "heading_skip", skip));

	const words = snapshot.wordCount;
	const images = page.facts?.page?.images ?? snapshot.images;
	const rawWords = page.facts?.render?.rawWords ?? 0;
	if (words === 0 && images === 0 && rawWords === 0) found.push(finding(key, "html_empty"));
	const path = key.slice(key.indexOf("/"));
	if (
		words !== null &&
		words < t.thinWords &&
		!isHome(page, context) &&
		!LITTLE_TEXT_PATHS.test(path)
	) {
		found.push(finding(key, "thin_content", { words, min: t.thinWords }));
	}
	const lorem = page.facts?.markup?.loremIpsum ?? null;
	if (lorem !== null) found.push(finding(key, "lorem_ipsum", { example: lorem }));
	found.push(...languageFindings(page, snapshot));
	return found;
}
