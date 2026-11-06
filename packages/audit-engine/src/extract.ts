import type { SeoPageHeading, SeoPageHreflang, SeoPageLinkPlacementValue } from "./facts";
import { Parser } from "htmlparser2";

import {
	imageHidden,
	imageLazyMethod,
	imageSized,
	imageSmall,
	imageSource,
	mixedContentOf
} from "./extract-audit";
import { extractMarkup, markupSourceCounter } from "./extract-markup";
import {
	elementRegion,
	elementsHoldingMainText,
	pageFormJudge,
	SKIP_TEXT
} from "./extract-regions";
import { countWords } from "./main-text";
import { SEO_READING_LIMITS } from "./reading-limits";
import { isPlatformPath } from "./scope";
import { parseBoundedJson } from "./structured-json";
import type { ExtractedAuditFacts, ExtractedLink, ExtractedPage, IsoDate } from "./types";

/**
 * THE EXTRACTOR: one pass of `htmlparser2` over a page, reading LibreCrawl's fields
 * (`core/seo_extractor.py`: title, description, headings, canonical, robots, lang, viewport, Open
 * Graph, Twitter cards, JSON-LD and microdata types, hreflang, images and links) plus two things it
 * never had:
 *
 * - THE MAIN TEXT. Navigation, headers, footers, sidebars, forms (not one that wraps the page),
 *   cookie and share widgets are stripped (what is chrome: `./extract-regions`); when the page marks a
 *   `<main>` or an `<article>`, only that is read. This is what the change history hashes, so a menu
 *   edit is not a content change.
 * - WHERE EACH LINK SITS: body, nav (nav, header, sidebar, menus), footer, or image.
 *
 * Beside it, the markup read (`./extract-markup`): a standards-following parse that knows where each
 * element landed, for the site audit's head, directive, link, form and social checks.
 */

/**
 * The words the main content (`<main>`, articles) needs before it stands for the page; under them the
 * page's text outside chrome is read.
 */
const MAIN_TEXT_MIN_WORDS = 30;

/** Elements that end a line of text. */
export const BLOCK_TAGS = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"li",
	"ul",
	"ol",
	"dl",
	"dt",
	"dd",
	"tr",
	"td",
	"th",
	"table",
	"br",
	"hr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"pre",
	"figure",
	"figcaption",
	"header",
	"footer",
	"nav",
	"aside"
]);

/**
 * A Content-Security-Policy that has the browser fetch every `http://` subresource over https, so the
 * page loads no mixed content whatever its markup spells.
 */
export const UPGRADE_INSECURE = /(?:^|;)\s*upgrade-insecure-requests\s*(?:;|$)/i;

/**
 * Markers of a bot challenge served in place of the page. Cloudflare's challenge page loads its
 * orchestrator from `/cdn-cgi/challenge-platform/h/`; the bot detection script it injects into every
 * normal page (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`) is no challenge, nor is the script
 * Imperva injects into every page it serves (`/_Incapsula_Resource?SWJIYLWA=`): its block page frames
 * `/_Incapsula_Resource?CWUDNSAI=` and names an incident.
 */
const BOT_WALL_MARKERS =
	/cf-browser-verification|challenge-platform\/h\/|cf_chl_|_Incapsula_Resource\?CWUDNSAI|Incapsula incident ID|px-captcha|captcha-delivery\.com|Pardon Our Interruption|Attention Required! \| Cloudflare|<title>\s*Just a moment\.\.\.\s*<\/title>/i;

/** The most headings kept per page. */
const MAX_HEADINGS = 100;

/** The longest heading text kept. */
const MAX_HEADING_CHARS = 300;

/** An image is the page's likely main (largest) image only while fewer words than this came before it. */
const HERO_WORDS_BEFORE = 150;

/** One open element. */
interface Frame {
	tag: string;
	/** Inside an element whose text is never read (a script, a style, a form control...). */
	skip: boolean;
	/**
	 * Skipped only for a `<button>` (none of its other skipped ancestors): its words are no page text,
	 * but a link wrapping the button is named by them, as a browser names it.
	 */
	buttonText: boolean;
	/**
	 * Inside an element the page keeps out of view (`hidden`: a closed tab, a collapsed menu): its text
	 * is no page text, but a link there still carries its anchor text.
	 */
	concealed: boolean;
	/**
	 * Inside an `aria-hidden` element: hidden from screen readers, still shown and read by search
	 * engines. A dialog's script hides the page this way while it is open, so the page's `<main>`
	 * clears it.
	 */
	muted: boolean;
	/**
	 * Inside page chrome: by tag or role, or by a class or id name where the element holds none of the
	 * page's main text (`./extract-regions`).
	 */
	chrome: boolean;
	/**
	 * Inside a dialog (`<dialog>`, `role="dialog"` or `"alertdialog"`, or a consent layer by its names)
	 * outside the page's main content: a consent or sign-up layer, whose headings are not the page's own.
	 */
	dialog: boolean;
	main: boolean;
	placement: "nav" | "footer" | null;
	/** Whether the element is inside a `<noscript>`, or an `<svg>`. */
	noscript: boolean;
	svg: boolean;
}

/** A link being read. */
interface OpenLink {
	href: string;
	text: string;
	imageAlt: string;
	/** The link's accessible label (`aria-label`, else `title`, else a label inside it), for a link with no text. */
	label: string;
	hasImage: boolean;
	placement: SeoPageLinkPlacementValue;
	nofollow: boolean;
	depth: number;
}

/**
 * Collapses whitespace.
 *
 * @param value - The text.
 * @returns It trimmed, every run of whitespace one space.
 */
function clean(value: string): string {
	return value.replaceAll("\u0000", "").replace(/\s+/g, " ").trim();
}

/**
 * Reads a date as a calendar day.
 *
 * @param value - An ISO date or date-time, or anything `Date` parses.
 * @returns `YYYY-MM-DD`, or null when it is not a plausible date.
 */
export function readDay(value: unknown): IsoDate | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const direct = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
	let day: string | null = null;
	if (direct) {
		day = `${direct[1]}-${direct[2]}-${direct[3]}`;
	} else {
		const parsed = Date.parse(trimmed);
		if (Number.isFinite(parsed)) day = new Date(parsed).toISOString().slice(0, 10);
	}
	if (day === null) return null;
	const year = Number.parseInt(day.slice(0, 4), 10);
	if (year < 1990 || year > 2100) return null;
	return Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? null : day;
}

/** What the JSON-LD blocks of a page said. */
interface JsonLdFound {
	types: Set<string>;
	published: IsoDate | null;
	modified: IsoDate | null;
	/** Blocks that were not valid JSON. */
	unreadable: number;
}

/**
 * Walks a JSON-LD value for its types and dates: top-level items and `@graph` members.
 *
 * @param value - The parsed JSON-LD.
 * @param into - Where types and dates go.
 */
function readJsonLd(value: unknown, into: JsonLdFound): void {
	if (Array.isArray(value)) {
		for (const item of value) readJsonLd(item, into);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	const type = record["@type"];
	if (typeof type === "string") into.types.add(type);
	if (Array.isArray(type)) {
		for (const entry of type) if (typeof entry === "string") into.types.add(entry);
	}
	into.published ??= readDay(record.datePublished);
	into.modified ??= readDay(record.dateModified);
	if (Array.isArray(record["@graph"])) readJsonLd(record["@graph"], into);
}

/**
 * Resolves an href against the page.
 *
 * @param href - The attribute value.
 * @param base - The page (or `<base>`) URL.
 * @returns The absolute http(s) URL, or null.
 */
function resolveHref(href: string, base: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return null;
	if (/^(?:mailto|tel|javascript|data|sms|ftp):/i.test(trimmed)) return null;
	try {
		const url = new URL(trimmed, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

/**
 * Extracts every field the crawler stores from one HTML page.
 *
 * @param html - The page's HTML.
 * @param pageUrl - The URL it was read at, for resolving links.
 * @param options.rendered - Whether `html` is a browser's rendered DOM rather than the HTML as served.
 * @returns The extracted page.
 */
export function extractPage(
	html: string,
	pageUrl: string,
	options: { rendered?: boolean } = {}
): ExtractedPage {
	const sourceTags = markupSourceCounter();
	const stack: Frame[] = [];
	const headings: SeoPageHeading[] = [];
	const hreflang: SeoPageHreflang[] = [];
	const links: ExtractedLink[] = [];
	const jsonLd: JsonLdFound = {
		types: new Set<string>(),
		published: null,
		modified: null,
		unreadable: 0
	};
	const microdataTypes = new Set<string>();
	const forms = pageFormJudge(html);
	const allLines: string[] = [];
	const mainLines: string[] = [];
	let allLine = "";
	let mainLine = "";
	// A link or a button ended: when the next text starts with a letter or digit, the two are separate
	// words (link rows and buttons are often written with no space between them in the markup).
	let afterControl = false;
	const holdsMainText = elementsHoldingMainText(html, undefined, forms);
	let elementIndex = -1;
	let base = pageUrl;
	let baseSet = false;
	let title: string | null = null;
	let titleBuffer: string | null = null;
	let metaDescription = "";
	const robots: string[] = [];
	let canonical = "";
	let lang = "";
	let viewport = "";
	let hasOpenGraph = false;
	let hasTwitterCard = false;
	let metaPublished: IsoDate | null = null;
	let metaModified: IsoDate | null = null;
	let images = 0;
	let imagesMissingAlt = 0;
	let h1 = "";
	let h1Count = 0;
	let heading: { level: number; text: string; alt: boolean } | null = null;
	let h1Empty = 0;
	let script: { text: string } | null = null;
	let link: OpenLink | null = null;
	const canonicals: string[] = [];
	const jsonLdTexts: string[] = [];
	const mixedActive: string[] = [];
	const mixedPassive: string[] = [];
	const unsizedImages: string[] = [];
	let auditImages = 0;
	let heroSeen = false;
	let lazyHero: ExtractedAuditFacts["lazyHero"] = null;
	let wordsSoFar = 0;
	let upgradesInsecure = false;

	const top = (): Frame | undefined => stack[stack.length - 1];
	const breakLine = (): void => {
		if (allLine.trim() !== "") allLines.push(clean(allLine));
		if (mainLine.trim() !== "") mainLines.push(clean(mainLine));
		allLine = "";
		mainLine = "";
	};

	const parser = new Parser(
		{
			onopentag(name, attribs) {
				sourceTags.open(name, parser.startIndex);
				elementIndex += 1;
				const parent = top();
				const region = elementRegion(
					name,
					attribs,
					parent?.main ?? false,
					name === "form" && forms.wraps(parser.endIndex + 1)
				);
				const { opensMain } = region;
				const nameCounts = !holdsMainText.has(elementIndex);
				const hidden = "hidden" in attribs;
				const ariaHidden = (attribs["aria-hidden"] ?? "").toLowerCase() === "true";
				const chromeHere = region.chromeByTag || (nameCounts && region.namedChrome);
				const placement = opensMain
					? null
					: (parent?.placement ??
						region.placementByTag ??
						(nameCounts ? region.namedPlacement : null));
				const frame: Frame = {
					tag: name,
					skip: (parent?.skip ?? false) || SKIP_TEXT.has(name),
					buttonText:
						name === "button"
							? !(parent?.skip ?? false) || (parent?.buttonText ?? false)
							: (parent?.buttonText ?? false) && !SKIP_TEXT.has(name),
					concealed: (parent?.concealed ?? false) || hidden,
					muted: (!opensMain && (parent?.muted ?? false)) || ariaHidden,
					chrome: (!opensMain && (parent?.chrome ?? false)) || chromeHere,
					dialog: (!opensMain && (parent?.dialog ?? false)) || region.dialog,
					main: (parent?.main ?? false) || opensMain || name === "article",
					placement,
					noscript: (parent?.noscript ?? false) || name === "noscript",
					svg: (parent?.svg ?? false) || name === "svg"
				};
				stack.push(frame);
				if (BLOCK_TAGS.has(name)) breakLine();
				const inNoscript = frame.noscript;
				if (!inNoscript) {
					const mixed = mixedContentOf(name, attribs);
					mixedActive.push(...mixed.active);
					mixedPassive.push(...mixed.passive);
				}
				if (name === "img" && !inNoscript && !imageHidden(attribs)) {
					auditImages += 1;
					if (!imageSized(attribs)) unsizedImages.push(imageSource(attribs));
					const content = !frame.chrome || frame.main;
					if (
						!heroSeen &&
						content &&
						wordsSoFar < HERO_WORDS_BEFORE &&
						!imageSmall(attribs) &&
						imageSource(attribs) !== ""
					) {
						heroSeen = true;
						const method = imageLazyMethod(attribs);
						if (method !== "none") lazyHero = { src: imageSource(attribs), method };
					}
				}

				if (name === "base" && attribs.href !== undefined && !baseSet) {
					baseSet = true;
					base = resolveHref(attribs.href, pageUrl) ?? base;
				} else if (name === "html" && attribs.lang) {
					lang = clean(attribs.lang);
				} else if (name === "title" && title === null && !frame.svg) {
					titleBuffer = "";
				} else if (name === "meta") {
					const key = (attribs.name ?? attribs.property ?? attribs.itemprop ?? "").toLowerCase();
					const content = attribs.content ?? "";
					if (
						(attribs["http-equiv"] ?? "").trim().toLowerCase() === "content-security-policy" &&
						UPGRADE_INSECURE.test(content)
					)
						upgradesInsecure = true;
					if (key === "description" && metaDescription === "") metaDescription = clean(content);
					else if (key === "robots" || key === "googlebot")
						robots.push(clean(content).toLowerCase());
					else if (key === "viewport") viewport = clean(content);
					else if (key.startsWith("og:")) hasOpenGraph = true;
					else if (key.startsWith("twitter:")) hasTwitterCard = true;
					else if (key === "article:published_time" || key === "datepublished")
						metaPublished ??= readDay(content);
					else if (key === "article:modified_time" || key === "datemodified")
						metaModified ??= readDay(content);
				} else if (name === "link") {
					const rel = (attribs.rel ?? "").toLowerCase().split(/\s+/);
					if (rel.includes("canonical") && attribs.href) {
						const target = resolveHref(attribs.href, base);
						if (target !== null && canonicals.length < SEO_READING_LIMITS.listItems)
							canonicals.push(target);
						if (canonical === "") canonical = target ?? "";
					} else if (
						rel.includes("alternate") &&
						attribs.hreflang &&
						attribs.href &&
						hreflang.length < SEO_READING_LIMITS.hreflang
					) {
						hreflang.push({ lang: clean(attribs.hreflang), url: attribs.href.trim() });
					}
				} else if (name === "script") {
					if ((attribs.type ?? "").toLowerCase().includes("ld+json")) script = { text: "" };
				} else if (/^h[1-6]$/.test(name) && !frame.dialog) {
					heading = { level: Number.parseInt(name.slice(1), 10), text: "", alt: false };
				} else if (name === "img") {
					images += 1;
					if (!("alt" in attribs)) imagesMissingAlt += 1;
					if (heading !== null && clean(attribs.alt ?? "") !== "") heading.alt = true;
					if (link !== null) {
						link.hasImage = true;
						if (link.imageAlt === "") link.imageAlt = clean(attribs.alt ?? "");
					}
				} else if (name === "a" && attribs.href && link === null) {
					const href = resolveHref(attribs.href, base);
					if (href !== null && !isPlatformPath(href)) {
						link = {
							href,
							text: "",
							imageAlt: "",
							label: clean(attribs["aria-label"] ?? attribs.title ?? ""),
							hasImage: false,
							placement: frame.placement ?? "body",
							nofollow: /\bnofollow\b/i.test(attribs.rel ?? ""),
							depth: stack.length
						};
					}
				}
				if (link !== null && link.label === "" && name !== "a" && attribs["aria-label"]) {
					link.label = clean(attribs["aria-label"]);
				}
				if (attribs.itemtype) {
					for (const type of attribs.itemtype.split(/\s+/)) {
						const last = type
							.replace(/(?<!\/)\/+$/, "")
							.split("/")
							.pop();
						if (last) microdataTypes.add(last);
					}
				}
			},
			ontext(text) {
				sourceTags.text(text);
				if (titleBuffer !== null) titleBuffer += text;
				if (script !== null) {
					script.text += text;
					return;
				}
				const frame = top();
				if (frame === undefined) return;
				if (frame.skip) {
					if (link !== null && frame.buttonText) link.text += text;
					return;
				}
				if (link !== null) link.text += text;
				if (frame.concealed || frame.muted) return;
				if (heading !== null) heading.text += text;
				if (afterControl && text !== "") {
					afterControl = false;
					if (/^[\p{L}\p{N}]/u.test(text)) {
						if (/\S$/u.test(allLine)) allLine += " ";
						if (/\S$/u.test(mainLine)) mainLine += " ";
					}
				}
				if (!frame.chrome) {
					if (wordsSoFar < HERO_WORDS_BEFORE) {
						wordsSoFar += countWords(text);
					}
					allLine += text;
					if (frame.main) mainLine += text;
				}
			},
			onclosetag(name, implied) {
				sourceTags.close(name, parser.startIndex, implied);
				if (name === "title" && titleBuffer !== null) {
					title = clean(titleBuffer);
					titleBuffer = null;
				} else if (name === "script" && script !== null) {
					const source = script.text;
					script = null;
					jsonLdTexts.push(source);
					const parsed = parseBoundedJson(source);
					if (parsed.kind === "value") readJsonLd(parsed.value, jsonLd);
					else if (parsed.kind === "invalid") jsonLd.unreadable += 1;
				} else if (/^h[1-6]$/.test(name) && heading !== null) {
					const text = clean(heading.text).slice(0, MAX_HEADING_CHARS);
					if (heading.level === 1) {
						h1Count += 1;
						if (h1 === "") h1 = text;
						if (text === "" && !heading.alt) h1Empty += 1;
					}
					if (headings.length < MAX_HEADINGS && text !== "") {
						headings.push({ level: heading.level, text });
					}
					heading = null;
				} else if (name === "a" && link !== null && stack.length <= link.depth) {
					const anchor = clean(link.text);
					links.push({
						href: link.href,
						anchor: anchor !== "" ? anchor : link.imageAlt !== "" ? link.imageAlt : link.label,
						placement:
							anchor === "" && link.hasImage && link.placement === "body"
								? "image"
								: link.placement,
						nofollow: link.nofollow
					});
					link = null;
				}
				if (name === "a" || name === "button") afterControl = true;
				if (BLOCK_TAGS.has(name)) breakLine();
				for (let index = stack.length - 1; index >= 0; index -= 1) {
					if (stack[index]?.tag === name) {
						stack.length = index;
						break;
					}
				}
			}
		},
		{ decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
	);
	parser.write(html);
	parser.end();
	breakLine();

	const mainText = (
		countWords(mainLines.join(" ")) >= MAIN_TEXT_MIN_WORDS ? mainLines : allLines
	).join("\n");
	const wordCount = countWords(mainText);
	const schemaTypes = [...new Set([...jsonLd.types, ...microdataTypes])].sort();
	return {
		title: title ?? "",
		metaDescription,
		h1,
		h1Count,
		h1Empty,
		headings,
		canonical,
		metaRobots: robots.filter((value) => value !== "").join(", "),
		lang,
		viewport,
		schemaTypes,
		hreflang,
		hasOpenGraph,
		hasTwitterCard,
		images,
		imagesMissingAlt,
		datePublished: jsonLd.published ?? metaPublished,
		dateModified: jsonLd.modified ?? metaModified,
		links,
		mainText,
		wordCount,
		botWall: wordCount < 200 && BOT_WALL_MARKERS.test(html.slice(0, 200_000)),
		audit: {
			canonicals,
			jsonLd: jsonLdTexts,
			mixedActive: upgradesInsecure ? [] : mixedActive,
			mixedPassive: upgradesInsecure ? [] : mixedPassive,
			images: auditImages,
			unsizedImages,
			lazyHero
		},
		markup: extractMarkup(html, pageUrl, {
			rendered: options.rendered === true,
			source: sourceTags.result()
		})
	};
}
