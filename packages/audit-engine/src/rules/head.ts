import type { SeoPageHeadFacts, SeoPageMarkupFacts, SeoPageRenderFacts } from "../facts";

import { bareHostOfKey } from "../scope";
import { AUDIT_EXAMPLES, finding, htmlSnapshot, onOwnHost } from "./page-state";
import { RENDERING_THRESHOLDS } from "./rendering";
import type { AuditFinding, AuditPage, AuditResourceRule } from "./types";

/**
 * THE HTML VALIDITY RULES: whether the head holds what search engines read there, whether the
 * document is built the way parsers expect, and whether it fits what Googlebot reads.
 *
 * Read from the page as stored (the rendered DOM whenever the browser rendered it), so every element
 * is judged where the browser placed it. The raw HTML's head is read only for what the browser
 * repairs away (the document's own `<html>`, `<head>` and `<body>` tags) and to name the element that
 * ended the head early.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - an element that ends `<head>` early is filed only when something search engines read there (a
 *   canonical, a robots meta, hreflang, the title, the description) landed in `<body>` after it, and
 *   on a rendered page judged from the HTML the server sent: an element a script inserts after the
 *   page was parsed moves nothing (`headBreakOf`);
 * - an image or frame inside a `<noscript>` in the head is NOT an error: Google lists `<noscript>` as
 *   valid in `<head>` and renders pages with scripting on, where its content is inert text (Google
 *   Search Central, "Use valid HTML to specify page metadata"); the head rules leave such a page alone;
 * - a document without its optional `<html>`, `<head>` or `<body>` tags is valid HTML; only a
 *   repeated tag, content before `<html>` or a head opened before its own tag is filed;
 * - a `<base>` with only a `target` is valid; several identical ones are not a conflict; an empty
 *   `href` resolves to the page's own address, so it changes no link (some site builders write one
 *   on every page);
 * - HTML over what Googlebot reads is an error (`html_over_2mb`) only when the cut part holds a head
 *   element search engines read or part of the main text; a cut that drops only the end of the page
 *   (a footer, trailing scripts) is a warning (`html_over_2mb_minor`). A read made before the cut was
 *   measured stays an error.
 */

/** Bytes of an HTML file or a script or stylesheet Googlebot reads; the rest is cut off. */
export const GOOGLEBOT_FILE_BYTES = 2 * 1024 * 1024;

/** What a head element is, for the lists the head rules file. */
type HeadElement = "canonical" | "robots" | "hreflang" | "title" | "description";

/** The elements that tell search engines how to index the page. */
const DIRECTIVES: readonly HeadElement[] = ["canonical", "robots", "hreflang"];

/**
 * The render's record of a script changing each head element's value: no record means the rendered
 * page holds the value the server sent.
 */
const CHANGE_OF: Record<HeadElement, keyof SeoPageRenderFacts["changed"]> = {
	canonical: "canonical",
	robots: "robots",
	hreflang: "hreflang",
	title: "title",
	description: "metaDescription"
};

/**
 * The head elements the parser placed in `<body>`, by kind.
 *
 * @param markup - The page's markup facts.
 * @returns The kinds found outside the head.
 */
export function outsideHead(markup: SeoPageMarkupFacts): HeadElement[] {
	const kinds: HeadElement[] = [];
	if (markup.canonicals.some((entry) => !entry.inHead)) kinds.push("canonical");
	if (markup.robots.some((entry) => !entry.inHead)) kinds.push("robots");
	if (markup.hreflangOutsideHead > 0) kinds.push("hreflang");
	if (markup.titles.some((entry) => !entry.inHead)) kinds.push("title");
	if (markup.descriptions.some((entry) => !entry.inHead)) kinds.push("description");
	return kinds;
}

/**
 * The raw HTML's own document tags: the render's raw head when the page was rendered, else the
 * stored markup's (then read from the raw HTML itself).
 *
 * @param page - The page.
 * @param markup - The stored markup.
 * @returns The head facts of the raw HTML, or null when they were not kept.
 */
function rawHeadOf(page: AuditPage, markup: SeoPageMarkupFacts): SeoPageHeadFacts | null {
	const rendered = page.snapshot?.mode === "browser" || page.fetchMode === "browser";
	if (!rendered) return markup.head;
	return page.facts?.render?.rawHead ?? null;
}

/**
 * The element that ended the head early and the elements search engines read that landed in
 * `<body>` after it. On a rendered page whose saved copy shows such an element, the raw HTML as the
 * server sent it decides: a script that inserts an element (a `<div>` some site builders' script
 * library puts before `<head>` on every page) moves nothing else in the rendered page, so the head
 * keeps its title, canonical and description there, and only a fresh parse of the saved copy would
 * push them into the body; search engines read the head from the HTML the server sent.
 *
 * @param page - The page.
 * @param markup - The stored markup (the rendered copy when the browser rendered the page).
 * @param raw - The raw HTML's head facts, or null when they were not kept.
 * @returns The element and what landed in the body after it.
 */
function headBreakOf(
	page: AuditPage,
	markup: SeoPageMarkupFacts,
	raw: SeoPageHeadFacts | null
): { breaker: SeoPageHeadFacts["breaker"] | null; lost: HeadElement[] } {
	const rendered = page.snapshot?.mode === "browser" || page.fetchMode === "browser";
	const rawLost = page.facts?.render?.rawOutsideHead;
	if (rendered && markup.head.breaker != null && rawLost !== undefined) {
		return { breaker: raw?.breaker ?? null, lost: rawLost };
	}
	const changed = page.facts?.render?.changed ?? {};
	const moved = (kind: HeadElement): boolean =>
		rendered && rawLost !== undefined && !rawLost.includes(kind) && !(CHANGE_OF[kind] in changed);
	return {
		breaker: markup.head.breaker ?? raw?.breaker ?? null,
		lost: outsideHead(markup).filter((kind) => !moved(kind))
	};
}

/**
 * How the raw document's tags are broken, if they are.
 *
 * @param head - The raw head facts.
 * @returns The kinds, empty when the structure is sound.
 */
function structureProblems(head: SeoPageHeadFacts): string[] {
	const kinds: string[] = [];
	if (head.htmlTags > 1) kinds.push("multiple_html");
	if (head.headTags > 1) kinds.push("multiple_head");
	if (head.bodyTags > 1) kinds.push("multiple_body");
	if (head.contentBeforeHtml) kinds.push("content_before_html");
	if (head.headNotFirst) kinds.push("head_not_first");
	return kinds;
}

/**
 * What is wrong with the page's `<base>` elements, or null when nothing is.
 *
 * @param markup - The markup facts.
 * @param pageUrl - The page's URL.
 * @returns The kind, or null.
 */
function baseProblem(markup: SeoPageMarkupFacts, pageUrl: string): string | null {
	const withHref = markup.bases.filter((base) => base.href !== null);
	if (withHref.length === 0) return null;
	if (new Set(withHref.map((base) => base.href)).size > 1) return "multiple";
	const base = withHref[0];
	if (base === undefined || base.href === null) return null;
	if (base.href.trim() === "") return null;
	try {
		const url = new URL(base.href, pageUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "malformed";
	} catch {
		return "malformed";
	}
	return base.inHead ? null : "outside_head";
}

/**
 * The HTML validity findings of one page.
 *
 * @param page - The page.
 * @returns Its findings.
 */
export function headFindings(page: AuditPage): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null || snapshot.mode === "rendered") return [];
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const size = page.facts?.sizeBytes ?? snapshot.sizeBytes ?? 0;
	if (size > GOOGLEBOT_FILE_BYTES) {
		const cut = page.facts?.htmlCut;
		const minor = cut !== undefined && !cut.head && !cut.mainText;
		found.push(
			finding(key, minor ? "html_over_2mb_minor" : "html_over_2mb", {
				bytes: size,
				max: GOOGLEBOT_FILE_BYTES
			})
		);
	}
	const markup = page.facts?.markup ?? null;
	if (markup === null) return found;

	const raw = rawHeadOf(page, markup);
	const { breaker, lost } = headBreakOf(page, markup, raw);
	if (breaker?.inNoscript !== true && lost.length > 0) {
		if (breaker !== null) {
			found.push(
				finding(key, "head_invalid_element", {
					tag: breaker.tag,
					line: breaker.line,
					lost
				})
			);
		} else {
			const directives = lost.filter((kind) => DIRECTIVES.includes(kind));
			const metadata = lost.filter((kind) => !DIRECTIVES.includes(kind));
			if (directives.length > 0) {
				found.push(finding(key, "directive_outside_head", { elements: directives }));
			}
			if (metadata.length > 0) {
				found.push(finding(key, "metadata_outside_head", { elements: metadata }));
			}
		}
	}
	const structure = raw === null ? [] : structureProblems(raw);
	if (structure.length > 0) {
		found.push(finding(key, "html_structure_broken", { kinds: structure, kind: structure[0] }));
	}
	const base = baseProblem(markup, snapshot.finalUrl ?? `https://${key}`);
	if (base !== null) found.push(finding(key, "base_tag_invalid", { kind: base }));
	const plugins = markup.plugins.applet + (markup.plugins.legacy ?? 0);
	if (plugins > 0) found.push(finding(key, "unsupported_plugins", { applets: plugins }));
	return found;
}

/**
 * Whether scripts build the page's main content: the render holds real text and the raw HTML at most
 * a quarter of it (the rendering rules' own test).
 *
 * @param page - The page.
 * @returns Whether they do.
 */
function builtByScript(page: AuditPage): boolean {
	const render = page.facts?.render ?? null;
	if (render === null) return false;
	const words = render.renderedWords ?? 0;
	const t = RENDERING_THRESHOLDS;
	return words >= t.jsContentMinWords && render.rawWords <= words * t.jsContentRawShare;
}

/**
 * The scripts and stylesheets a page loads that are over what Googlebot reads of a file, counted
 * unpacked (Googlebot's limit counts the file as unpacked, so a compressed file is judged by its
 * measured unpacked size). A stylesheet counts wherever it is served (a cut one changes the layout
 * Google judges); a script counts when the site serves it, or when scripts build the page's content:
 * another host's script on a page the server sends whole (an ad or analytics bundle) never changes
 * what Google reads.
 *
 * @param page - The page.
 * @param resources - What it loads, with the site's latest check of each.
 * @returns The finding, or nothing.
 */
export const oversizedResourceFindings: AuditResourceRule = (page, resources) => {
	const siteHost = bareHostOfKey(page.pageKey);
	const anyScript = builtByScript(page);
	const over = resources.filter((resource) => {
		if (resource.kind !== "script" && resource.kind !== "stylesheet") return false;
		if (resource.kind === "script" && !anyScript && !onOwnHost(resource.url, siteHost))
			return false;
		const bytes = resource.headers?.decodedBytes ?? resource.sizeBytes;
		return bytes !== null && bytes > GOOGLEBOT_FILE_BYTES;
	});
	if (over.length === 0) return [];
	return [
		finding(page.pageKey, "resource_over_2mb", {
			count: over.length,
			urls: over.map((resource) => resource.url).slice(0, AUDIT_EXAMPLES),
			max: GOOGLEBOT_FILE_BYTES
		})
	];
};
