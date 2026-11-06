import { Parser } from "htmlparser2";

import { countWords } from "./main-text";

/**
 * WHAT REGION OF A PAGE AN ELEMENT IS: content, or chrome (navigation, header, footer, sidebar, menus,
 * consent and share widgets), and where a link inside it sits.
 *
 * Structure decides first: chrome TAGS and ARIA ROLES (`<nav>`, `<footer>`, `role="banner"`) are chrome,
 * and the page's `<main>` is content whatever wraps it. Class and id NAMES are only a guess: a name
 * counts when one of its words names a region ({@link elementRegion}), and never when the element
 * holds the page's main text ({@link elementsHoldingMainText}): an element that holds most of the
 * text of the page (or of the `<main>` it sits in), and the main heading when there is one, is the
 * content whatever its name says (`wsite-not-footer`, `content-sidebar-wrap`, `with-nav`, a wrapper
 * called `sidebar` for its layout). So a name can misplace a small block, never the page's text.
 */

/** Elements whose text is never page text. */
export const SKIP_TEXT = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"iframe",
	"object",
	"canvas",
	"select",
	"option",
	"textarea",
	"button",
	"title"
]);

/** Elements that are page chrome by tag. */
const BOILERPLATE_TAGS = new Set(["nav", "header", "footer", "aside", "form", "dialog"]);

/** The end of a form, and the elements that make a form the page's own wrapper. */
const FORM_END = /<\/form\b/gi;
const PAGE_CONTENT_OPEN = /<(?:h1|main|article|header|nav|footer)\b/gi;

/** Judges each form of one page ({@link pageFormJudge}). */
export interface SeoPageFormJudge {
	/**
	 * Whether the form opening at an offset wraps the page.
	 *
	 * @param from - The offset just past the form's opening tag.
	 * @returns Whether it does.
	 */
	wraps(from: number): boolean;
	/** The characters of the page read so far: never more than twice its length, whatever its forms. */
	readonly scanned: number;
}

/**
 * The first index of a sorted list whose value is at least a number.
 *
 * @param list - The sorted offsets.
 * @param at - The number.
 * @returns The index, or the list's length when every value is below it.
 */
function firstAtOrAfter(list: readonly number[], at: number): number {
	let low = 0;
	let high = list.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((list[middle] ?? 0) < at) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * Whether each form of a page wraps the page: before it closes (forms do not nest) it holds the page's
 * H1, its `<main>` or an `<article>`, or the page's own `<header>`, `<nav>` or `<footer>`. A framework
 * that posts the whole page back (ASP.NET Web Forms' `<form id="aspnetForm">`, SharePoint) puts every
 * element in one form, which is the page, not a sign-up or search form. The page is read once, on its
 * first form, for the offsets of every form end and every such element; each form is then judged by two
 * binary searches, so a page of many forms, closed or not, costs no more than one read.
 *
 * @param html - The page's HTML.
 * @returns The judge.
 */
export function pageFormJudge(html: string): SeoPageFormJudge {
	let ends: number[] | null = null;
	let opens: number[] = [];
	let scanned = 0;
	const offsets = (pattern: RegExp): number[] => {
		scanned += html.length;
		return [...html.matchAll(pattern)].map((match) => match.index);
	};
	return {
		wraps(from) {
			if (ends === null) {
				ends = offsets(FORM_END);
				opens = offsets(PAGE_CONTENT_OPEN);
			}
			const end = ends[firstAtOrAfter(ends, from)] ?? html.length;
			const open = opens[firstAtOrAfter(opens, from)];
			return open !== undefined && open < end;
		},
		get scanned() {
			return scanned;
		}
	};
}

/** ARIA roles that are page chrome. */
const BOILERPLATE_ROLES = new Set([
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"dialog",
	"alertdialog",
	"search",
	"menu",
	"menubar"
]);

/**
 * Elements whose class and id never mark chrome: a theme names the whole document by its layout
 * (`<body class="footer-on-bottom has-sidebar">`), which says nothing about the content inside.
 */
const DOCUMENT_TAGS = new Set(["html", "body"]);

/** Class or id words that mark page chrome. */
const BOILERPLATE_NAMES =
	/(?:^|[\s_-])(?:nav|navbar|navigation|menu|breadcrumbs?|sidebar|footer|cookies?|consent|gdpr|share|sharing|social|newsletter|subscribe|popup|modal|advert|ads|related|comments?|skip-link)(?:[\s_-]|$)/i;

/**
 * Class or id words of a cookie consent layer that names no dialog role (TrustArc's
 * `truste-consent-content`, OneTrust's `onetrust-banner-sdk`, Cookiebot, Complianz): outside the main
 * content it is a layer over the page, chrome as a dialog is, and its headings are never the page's. A
 * page about cookies (`cookie-policy`) is no such layer.
 */
const CONSENT_LAYER_NAMES =
	/(?:^|[\s_-])(?:consent|gdpr|truste|onetrust|cookiebot|cmplz|cookie-?(?:banner|bar|notice|consent|popup|modal))(?:[\s_-]|$)/i;

/** Class or id words that mark the navigation placement of a link. */
const NAV_NAMES = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|breadcrumbs?|sidebar)(?:[\s_-]|$)/i;

/**
 * A class or id word naming a header, which places a link in the navigation outside the main content
 * (`site-header`) and never inside it (a post card's `entry-header`). It never makes text chrome: a
 * `page-header` or a `hero-header` holds the page's title and opening words.
 */
const HEADER_NAME = /(?:^|[\s_-])header(?:[\s_-]|$)/i;

/** Class or id words that mark the footer placement of a link. */
const FOOTER_NAMES = /(?:^|[\s_-])footer(?:[\s_-]|$)/i;

/**
 * Layout utility classes that only size or space an element by another's measure: a one-side margin
 * or padding (`pt-nav-height`, `mt-header`, `scroll-mt-header`), a least or most height or width
 * (`min-h-nav`), or a token that ends in a spacing measure (`nav-height`, `header-offset`). Names
 * that components carry are left alone: a bare `m-` or `p-` (`m-nav`), `w-` (a site builder's
 * `w-nav`), `ms-` (`ms-Nav`) and a width (`menu-full-width` is the menu).
 */
const LAYOUT_UTILITY =
	/^-?(?:scroll-)?[pm][trblxy]-|^(?:min|max)-[hw]-|-(?:height|offset|spacing|gap|padding|margin)$/i;

/**
 * A word a name negates (Weebly's `wsite-not-footer`, `no-sidebar`): the element says it is NOT that
 * chrome. Weebly names every content section so, the hero above the body too.
 */
const NEGATED_WORD = /(?:^|[_-])(?:not|no|non|without)[_-][a-z]+/gi;

/**
 * The most characters of an element's class and id read for its names: a long class list holds its
 * names early, and the name tests stay bounded on a hostile page.
 */
const MAX_NAME_CHARS = 1_000;

/**
 * The class and id words an element is NAMED by (the first {@link MAX_NAME_CHARS} characters). A utility token is no name: one that carries a value
 * (`[--fd-sidebar-width:268px]`, `min-h-(--fd-nav-height)`, `md:block`) or only spaces or sizes the
 * element by another's measure ({@link LAYOUT_UTILITY}); nor is a word the name negates
 * ({@link NEGATED_WORD}).
 *
 * @param attribs - The element's attributes.
 * @returns The naming words, space separated.
 */
function namingWords(attribs: Record<string, string>): string {
	return `${attribs.class ?? ""} ${attribs.id ?? ""}`
		.slice(0, MAX_NAME_CHARS)
		.split(/\s+/)
		.filter(
			(token) =>
				token !== "" &&
				!token.startsWith("--") &&
				!/[[\]():=]/.test(token) &&
				!LAYOUT_UTILITY.test(token)
		)
		.map((token) => token.replace(NEGATED_WORD, ""))
		.join(" ");
}

/** What an element's tag, role and names say about its region. */
export interface ElementRegion {
	/** It is the page's main content element (`<main>`, `role="main"`): content, whatever wraps it. */
	opensMain: boolean;
	/**
	 * Chrome by structure: a chrome tag (a `<header>` inside the main content excepted: a post card's
	 * own; and a `<form>` that wraps the page: {@link pageFormJudge}), a chrome role, or a consent
	 * layer outside the main content.
	 */
	chromeByTag: boolean;
	/** A layer over the page outside the main content (a dialog or a consent layer): its headings are not the page's. */
	dialog: boolean;
	/** Where the tag or role alone places a link inside it, or null. */
	placementByTag: "nav" | "footer" | null;
	/** Whether its class or id names it chrome (a guess: void where it holds the main text). */
	namedChrome: boolean;
	/** Where its class or id names place a link inside it, or null (a guess, as `namedChrome`). */
	namedPlacement: "nav" | "footer" | null;
}

/**
 * The region an element's tag, role and names say it is, before the main text guard.
 *
 * @param tag - The element's tag, lower case.
 * @param attribs - Its attributes.
 * @param insideMain - Whether it sits inside the main content (a `<main>` or an `<article>`).
 * @param wrapsPage - For a `<form>`, whether it wraps the page ({@link pageFormJudge}).
 * @returns Its region.
 */
export function elementRegion(
	tag: string,
	attribs: Record<string, string>,
	insideMain: boolean,
	wrapsPage = false
): ElementRegion {
	const role = (attribs.role ?? "").toLowerCase();
	const opensMain = tag === "main" || role === "main";
	const names = DOCUMENT_TAGS.has(tag) || opensMain ? "" : namingWords(attribs);
	const consentLayer = !insideMain && CONSENT_LAYER_NAMES.test(names);
	const chromeByTag =
		(BOILERPLATE_TAGS.has(tag) &&
			!(tag === "header" && insideMain) &&
			!(tag === "form" && wrapsPage)) ||
		BOILERPLATE_ROLES.has(role) ||
		consentLayer;
	const placementByTag =
		tag === "nav" ||
		(tag === "header" && !insideMain) ||
		tag === "aside" ||
		role === "navigation" ||
		role === "banner" ||
		role === "complementary"
			? "nav"
			: tag === "footer" || role === "contentinfo"
				? "footer"
				: null;
	return {
		opensMain,
		chromeByTag,
		dialog:
			!insideMain &&
			(tag === "dialog" || role === "dialog" || role === "alertdialog" || consentLayer),
		placementByTag,
		namedChrome: BOILERPLATE_NAMES.test(names),
		namedPlacement:
			NAV_NAMES.test(names) || (!insideMain && HEADER_NAME.test(names))
				? "nav"
				: FOOTER_NAMES.test(names)
					? "footer"
					: null
	};
}

/** The most H1s the guard keeps as candidates for the main heading. */
const MAX_HEADINGS = 50;

/** One open element of the guard's read. */
interface GuardFrame {
	tag: string;
	/** Its number in document order. */
	index: number;
	/** Inside an element whose text is never page text, or one kept out of view (`hidden`). */
	unread: boolean;
	/** Inside chrome by structure, or `aria-hidden`: both end at the page's `<main>`. */
	outside: boolean;
	/** Inside a `<main>` or an `<article>`. */
	main: boolean;
	/** The innermost `<main>` around it (its element number), or -1 for the page. */
	scope: number;
	/** Inside a link: its words are a menu's or a list's, not the text a page is read for. */
	link: boolean;
	/** Whether its words and extent are kept: a named element, or a `<main>` (a scope). */
	kept: boolean;
	/** The words read inside it so far, its closed children's included. */
	words: number;
	/** Whether a link opened inside it (itself included) so far. */
	holdsLink: boolean;
	/** The nearest kept element around it, itself included, or -1. */
	keptAt: number;
	/** Its place in the H1 candidates when it is one, else -1. */
	heading: number;
}

/** What the guard keeps of one named element or `<main>` once it closed. */
interface KeptElement {
	/** The innermost `<main>` around it, or -1 for the page (a `<main>`'s own is itself). */
	scope: number;
	/** The words inside it. */
	words: number;
	/** The number of the last element opened inside it (itself when none): its extent. */
	end: number;
	/** Whether a name says it is chrome (a `<main>` alone is kept as a scope). */
	named: boolean;
	/** Whether it holds a link. */
	holdsLink: boolean;
	/** The nearest kept element around it, or -1. */
	keptParent: number;
}

/** An H1 the guard keeps as a candidate for the main heading. */
interface HeadingCandidate {
	/** Its element number. */
	index: number;
	/** The innermost `<main>` around it, or -1 for the page. */
	scope: number;
	/** The words inside it (outside links). */
	words: number;
	/** The nearest kept element around it, itself included, or -1. */
	keptAt: number;
}

/** A counter of the guard's steps, for a caller that bounds or measures its work. */
export interface GuardWork {
	steps: number;
}

/**
 * THE MAIN TEXT GUARD: the elements whose class or id names them chrome but that hold the page's main
 * text, by their number in document order (the order a parse opens them in). Such an element is
 * content, its name void.
 *
 * An element holds the main text when it holds at least half the words of its scope (the innermost
 * `<main>` around it, else the page) and, when the scope has a main heading, that heading. Words count
 * outside links (a menu's words are its links), structural chrome, hidden and `aria-hidden` text. The
 * main heading is the scope's first H1 outside structural chrome that sits in no named element
 * failing the word test (a logo H1 in a header named so is not the page's heading). So a theme's
 * content wrapper is content whatever its name says, even on a short page under a long menu, while a
 * menu, a footer or a comment thread longer than the post stays chrome.
 *
 * The first H1 inside an element that holds the main text is that text's heading: the named elements
 * around it inside the holder that hold nothing else (no other words, no link) are its wrappers, not
 * chrome (a site builder's `t-store__prod-popup__title-wrapper` around a product's title). A menu bar
 * around a logo H1 holds links, and stays chrome.
 *
 * Linear in the page, however deep or wide: each text adds to its own element only and each element
 * hands its total to its parent as it closes; containment is read from element number ranges, and
 * the H1s inside a failing element from one prefix sum.
 *
 * @param html - The page's HTML.
 * @param work - Counts the steps taken, when given.
 * @param forms - The page's form judge, shared with the caller's own parse so the page is read once.
 * @returns The element numbers of named elements that hold the main text.
 */
export function elementsHoldingMainText(
	html: string,
	work?: GuardWork,
	forms: SeoPageFormJudge = pageFormJudge(html)
): ReadonlySet<number> {
	const stack: GuardFrame[] = [];
	const kept = new Map<number, KeptElement>();
	const headings: HeadingCandidate[] = [];
	let pageWords = 0;
	let elementIndex = -1;
	const step = (): void => {
		if (work !== undefined) work.steps += 1;
	};

	const closeTop = (): void => {
		const frame = stack.pop();
		if (frame === undefined) return;
		step();
		if (frame.kept) {
			const element = kept.get(frame.index);
			if (element !== undefined) {
				element.words = frame.words;
				element.end = elementIndex;
				element.holdsLink = frame.holdsLink;
			}
		}
		const heading = headings[frame.heading];
		if (heading !== undefined) heading.words = frame.words;
		const parent = stack[stack.length - 1];
		if (parent === undefined) pageWords += frame.words;
		else {
			parent.words += frame.words;
			parent.holdsLink ||= frame.holdsLink;
		}
	};

	const parser = new Parser(
		{
			onopentag(name, attribs) {
				step();
				elementIndex += 1;
				const parent = stack[stack.length - 1];
				const region = elementRegion(
					name,
					attribs,
					parent?.main ?? false,
					name === "form" && forms.wraps(parser.endIndex + 1)
				);
				const ariaHidden = (attribs["aria-hidden"] ?? "").toLowerCase() === "true";
				const scope = region.opensMain ? elementIndex : (parent?.scope ?? -1);
				const unread = (parent?.unread ?? false) || SKIP_TEXT.has(name) || "hidden" in attribs;
				const outside =
					(!region.opensMain && (parent?.outside ?? false)) || region.chromeByTag || ariaHidden;
				const named = !unread && !outside && (region.namedChrome || region.namedPlacement !== null);
				const isKept = named || region.opensMain;
				const isLink = name === "a" && "href" in attribs;
				const candidate =
					name === "h1" && !unread && !outside && !region.dialog && headings.length < MAX_HEADINGS;
				const keptAt = isKept ? elementIndex : (parent?.keptAt ?? -1);
				const frame: GuardFrame = {
					tag: name,
					index: elementIndex,
					unread,
					outside,
					main: (parent?.main ?? false) || region.opensMain || name === "article",
					scope,
					link: (parent?.link ?? false) || isLink,
					kept: isKept,
					words: 0,
					holdsLink: isLink,
					keptAt,
					heading: candidate ? headings.length : -1
				};
				stack.push(frame);
				if (isKept)
					kept.set(elementIndex, {
						scope: region.opensMain ? (parent?.scope ?? -1) : scope,
						words: 0,
						end: elementIndex,
						named,
						holdsLink: false,
						keptParent: parent?.keptAt ?? -1
					});
				if (candidate) headings.push({ index: elementIndex, scope, words: 0, keptAt });
			},
			ontext(text) {
				step();
				const frame = stack[stack.length - 1];
				if (frame === undefined || frame.unread || frame.outside || frame.link) return;
				frame.words += countWords(text);
			},
			onclosetag(name) {
				for (let index = stack.length - 1; index >= 0; index -= 1) {
					step();
					if (stack[index]?.tag !== name) continue;
					while (stack.length > index) closeTop();
					break;
				}
			}
		},
		{ decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
	);
	parser.write(html);
	parser.end();
	while (stack.length > 0) closeTop();

	const scopeWords = (scope: number): number =>
		scope === -1 ? pageWords : (kept.get(scope)?.words ?? 0);
	const contains = (outer: number, inner: number): boolean =>
		outer === -1 || (outer <= inner && inner <= (kept.get(outer)?.end ?? outer));
	const mostWords = new Set<number>();
	const failingAround = new Int32Array(elementIndex + 2);
	for (const [index, element] of kept) {
		step();
		if (!element.named) continue;
		if (element.words > 0 && element.words * 2 >= scopeWords(element.scope)) mostWords.add(index);
		else {
			failingAround[index] = (failingAround[index] ?? 0) + 1;
			failingAround[element.end + 1] = (failingAround[element.end + 1] ?? 0) - 1;
		}
	}
	for (let index = 1; index < failingAround.length; index += 1) {
		step();
		failingAround[index] = (failingAround[index] ?? 0) + (failingAround[index - 1] ?? 0);
	}
	const qualified = headings
		.filter((heading) => (failingAround[heading.index] ?? 0) === 0)
		.map((heading) => heading.index);
	const mainHeading = new Map<number, number | null>();
	const holding = new Set<number>();
	for (const index of mostWords) {
		step();
		const scope = kept.get(index)?.scope ?? -1;
		if (!mainHeading.has(scope)) {
			const first = qualified[scope === -1 ? 0 : firstAtOrAfter(qualified, scope)];
			mainHeading.set(scope, first !== undefined && contains(scope, first) ? first : null);
		}
		const heading = mainHeading.get(scope) ?? null;
		if (heading === null || contains(index, heading)) holding.add(index);
	}
	const headingAt = headings.map((heading) => heading.index);
	const walked = new Set<number>();
	for (const holder of [...holding]) {
		step();
		const first = headings[firstAtOrAfter(headingAt, holder)];
		if (first === undefined || !contains(holder, first.index)) continue;
		let at = first.keptAt;
		while (at !== -1 && at !== holder && !walked.has(at)) {
			step();
			walked.add(at);
			const element = kept.get(at);
			if (
				element === undefined ||
				!element.named ||
				element.holdsLink ||
				element.words !== first.words
			)
				break;
			holding.add(at);
			at = element.keptParent;
		}
	}
	return holding;
}
