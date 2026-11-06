import type {
	SeoPageBadLinkKindValue,
	SeoPageHeadFacts,
	SeoPageMarkupFacts,
	SeoPageMarkupImage,
	SeoPageRobotsGroup,
	SeoPageViewport,
	SeoSitePlatformValue
} from "./facts";
import type { DefaultTreeAdapterTypes } from "parse5";

import { imageHidden, imageSource, srcsetUrls } from "./extract-audit";
import { readStructuredData } from "./extract-structured";
import { parseWithinBudget } from "./markup-parse";
import { SEO_MARKUP_LIMITS } from "./reading-limits";
import { layoutSkeleton } from "./templates";
import type { ExtractedMarkup, ExtractedResource, ExtractedResourceKind } from "./types";

/**
 * THE MARKUP READ: a second pass over a page with `parse5`, a parser that builds the tree exactly as the
 * HTML standard (and so every browser and Google) does and keeps where each element came from. It reads
 * what a token-by-token pass cannot: where an element LANDED (a canonical after an `<img>` in the head is
 * moved into `<body>`, where Google ignores it), every tag of a kind rather than the first, and the facts
 * the site audit's markup rules judge. Pure: a string in, plain data out, so the server and the desktop
 * app read the same.
 *
 * The raw HTML is parsed with scripting OFF (a `<noscript>` in the head is then real markup, as for a
 * crawler that runs no script); a browser's rendered DOM with scripting on (as the browser built it).
 * The head facts are read from either the same way: on a rendered DOM they show what scripts put in the
 * head that a parser moves out of it again (an element a script inserted into `<head>` that ends it).
 */

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** The HTML namespace: elements of `<svg>` and `<math>` are not HTML tags. */
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** What the token pass saw of the document's own `<html>`, `<head>` and `<body>` tags. */
export interface MarkupSourceTags {
	html: number;
	head: number;
	body: number;
	/**
	 * Whether an element or text came before a written `<html>` tag. A page that writes no `<html>` tag
	 * at all (the tag is optional) has nothing before it.
	 */
	contentBeforeHtml: boolean;
	/** The source offset of the first written `</head>` or `<body>` tag, whichever comes first. */
	headEnd: number | null;
}

/** Counts the document tags a token pass meets, fed by the extractor's own pass. */
export interface MarkupSourceCounter {
	/** A start tag at a source offset. */
	open(name: string, offset: number): void;
	/** An end tag at a source offset; `implied` when the source never wrote it. */
	close(name: string, offset: number, implied: boolean): void;
	/** Text between tags. */
	text(value: string): void;
	/** What was counted. */
	result(): MarkupSourceTags;
}

/**
 * A counter of the document tags, for the extractor's token pass.
 *
 * @returns The counter.
 */
export function markupSourceCounter(): MarkupSourceCounter {
	const tags: MarkupSourceTags = {
		html: 0,
		head: 0,
		body: 0,
		contentBeforeHtml: false,
		headEnd: null
	};
	const endHead = (offset: number): void => {
		if (tags.headEnd === null || offset < tags.headEnd) tags.headEnd = offset;
	};
	return {
		open(name, offset) {
			if (name === "html") tags.html += 1;
			else if (tags.html === 0) tags.contentBeforeHtml = true;
			if (name === "head") tags.head += 1;
			if (name === "body") {
				tags.body += 1;
				endHead(offset);
			}
		},
		close(name, offset, implied) {
			if (name === "head" && !implied) endHead(offset);
		},
		text(value) {
			if (tags.html === 0 && value.trim() !== "") tags.contentBeforeHtml = true;
		},
		result: () => ({ ...tags, contentBeforeHtml: tags.contentBeforeHtml && tags.html > 0 })
	};
}

/**
 * Collapses whitespace and cuts a value.
 *
 * @param value - The value.
 * @param max - The most characters kept.
 * @returns It, collapsed and cut.
 */
function short(value: string, max: number = SEO_MARKUP_LIMITS.valueChars): string {
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * An element's attributes as a record, names lowercased (the first of a repeated name wins).
 *
 * @param element - The element.
 * @returns Its attributes.
 */
function attributesOf(element: Element): Record<string, string> {
	const record: Record<string, string> = {};
	for (const attr of element.attrs) {
		const name = attr.name.toLowerCase();
		if (!(name in record)) record[name] = attr.value;
	}
	return record;
}

/** The most nodes read under a link for its anchor text. */
const ANCHOR_NODES = 200;

/** The most sibling nodes read beside a link to tell whether it sits in a sentence. */
const SENTENCE_SIBLINGS = 50;

/** Judges whether links sit inside sentences ({@link sentenceJudge}). */
export interface SentenceJudge {
	/**
	 * Whether a link sits inside a sentence.
	 *
	 * @param element - The link.
	 * @returns Whether it does.
	 */
	inSentence(element: Element): boolean;
	/** The characters of text read so far: each text node at most once, however many links sit beside it. */
	readonly scanned: number;
}

/**
 * Whether links sit inside a sentence: the element holding a link has words of its own beside it
 * (`Open <a>localhost:3000</a> in your browser`), whatever element holds the sentence (a docs
 * platform writes its paragraphs as `<span data-as="p">`). At most {@link SENTENCE_SIBLINGS} children of
 * the holder are read, once per holder: the verdict is the holder's, so many links beside one long text
 * never read that text again for each link.
 *
 * @returns The judge, for one page.
 */
export function sentenceJudge(): SentenceJudge {
	const holders = new WeakMap<object, boolean>();
	let scanned = 0;
	return {
		inSentence(element) {
			const parent = element.parentNode;
			if (parent === null) return false;
			const known = holders.get(parent);
			if (known !== undefined) return known;
			let found = false;
			for (const node of parent.childNodes.slice(0, SENTENCE_SIBLINGS)) {
				if (node.nodeName !== "#text" || !("value" in node)) continue;
				scanned += node.value.length;
				if (/\p{L}{2}/u.test(node.value)) {
					found = true;
					break;
				}
			}
			holders.set(parent, found);
			return found;
		},
		get scanned() {
			return scanned;
		}
	};
}

/**
 * What a link says to its reader: its text, else an image's alt inside it, else its `aria-label` or
 * `title`; collapsed and cut, `""` when it says nothing. Bounded: at most {@link ANCHOR_NODES} nodes
 * under it are read, and a node's children are taken one at a time as the walk reaches them, so a
 * control above an element of a million children (nested controls each reading it) costs no more.
 *
 * @param element - The link.
 * @param work - Counts the nodes the walk took, when given.
 * @returns The anchor text.
 */
export function anchorTextOf(element: Element, work?: MarkupWork): string {
	const words: string[] = [];
	let alt = "";
	const open: { children: readonly Node[]; next: number }[] = [
		{ children: element.childNodes, next: 0 }
	];
	let seen = 0;
	let chars = 0;
	while (open.length > 0 && seen < ANCHOR_NODES && chars < SEO_MARKUP_LIMITS.exampleChars) {
		const level = open[open.length - 1];
		if (work !== undefined) work.steps += 1;
		const node = level?.children[level.next];
		if (level === undefined || node === undefined) {
			open.pop();
			continue;
		}
		level.next += 1;
		seen += 1;
		if (node.nodeName === "#text" && "value" in node) {
			words.push(node.value);
			chars += node.value.length;
			continue;
		}
		if (!("tagName" in node) || NOT_TEXT.has(node.tagName)) continue;
		if (node.tagName === "img" && alt === "") alt = attributesOf(node).alt ?? "";
		open.push({ children: node.childNodes, next: 0 });
	}
	const attribs = attributesOf(element);
	for (const candidate of [
		words.join(" "),
		alt,
		attribs["aria-label"] ?? "",
		attribs.title ?? ""
	]) {
		const text = short(candidate, SEO_MARKUP_LIMITS.exampleChars);
		if (text !== "") return text;
	}
	return "";
}

/**
 * A URL resolved against a base.
 *
 * @param href - The value as written.
 * @param base - The base URL.
 * @returns The absolute URL, or null when it cannot be resolved.
 */
function resolve(href: string, base: string): string | null {
	try {
		return new URL(href.trim(), base).href;
	} catch {
		return null;
	}
}

/**
 * An http(s) URL resolved against a base, its fragment dropped.
 *
 * @param href - The value as written.
 * @param base - The base URL.
 * @returns The absolute URL, or null when it is not an http(s) URL.
 */
function resolveHttp(href: string, base: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "" || /^(?:data|blob|javascript|about):/i.test(trimmed)) return null;
	try {
		const url = new URL(trimmed, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

/** Directives of a robots meta or header that carry a value after a colon. */
const VALUED_DIRECTIVES = new Set([
	"max-snippet",
	"max-image-preview",
	"max-video-preview",
	"unavailable_after"
]);

/** A meta `name` that addresses crawlers: `robots`, or one crawler. */
const ROBOTS_META_NAME = /^(?:robots|[a-z][\w-]*bot(?:-[a-z]+)?|slurp|yandex|baiduspider)$/;

/**
 * A `name: value` part of a directive list.
 *
 * @param part - The part as written.
 * @returns The name (lowercased) and the value, or null when the part names nothing.
 */
function namedPart(part: string): { name: string; value: string } | null {
	const at = part.indexOf(":");
	if (at <= 0) return null;
	const name = part.slice(0, at).trim().toLowerCase();
	return /^[\w-]+$/.test(name) ? { name, value: part.slice(at + 1).trim() } : null;
}

/**
 * Splits a list of robots directives into tokens: lowercased, `name:value` without spaces, an
 * `unavailable_after` date kept whole even when it holds a comma.
 *
 * @param value - The directives as written.
 * @returns The tokens.
 */
export function robotsTokens(value: string): string[] {
	const tokens: string[] = [];
	for (const piece of value.split(",")) {
		const part = piece.trim().toLowerCase();
		if (part === "") continue;
		const previous = tokens.at(-1);
		const named = namedPart(part);
		if (
			previous?.startsWith("unavailable_after:") === true &&
			named === null &&
			!/^[a-z_-]+$/.test(part)
		) {
			tokens[tokens.length - 1] = `${previous}, ${part}`;
			continue;
		}
		tokens.push(named === null ? part.replace(/\s+/g, " ") : `${named.name}:${named.value}`);
	}
	return tokens
		.slice(0, SEO_MARKUP_LIMITS.robotsTokens)
		.map((token) => token.slice(0, SEO_MARKUP_LIMITS.valueChars));
}

/**
 * Reads an `X-Robots-Tag` header into groups per crawler: `googlebot: noindex` addresses Googlebot, a
 * directive with no name before it every crawler (`robots`). Several headers arrive joined by commas;
 * a crawler name holds until the next one.
 *
 * @param header - The header, or null.
 * @returns The groups, in order of first mention.
 */
export function xRobotsTagGroups(header: string | null | undefined): SeoPageRobotsGroup[] {
	if (header === null || header === undefined) return [];
	const groups = new Map<string, string[]>();
	let agent = "robots";
	const pieces: string[] = [];
	for (const piece of header.split(",")) {
		const named = namedPart(piece);
		if (named !== null && !VALUED_DIRECTIVES.has(named.name)) {
			if (pieces.length > 0) {
				groups.set(agent, [...(groups.get(agent) ?? []), ...robotsTokens(pieces.join(","))]);
				pieces.length = 0;
			}
			agent = named.name;
			pieces.push(named.value);
		} else {
			pieces.push(piece);
		}
	}
	if (pieces.length > 0) {
		groups.set(agent, [...(groups.get(agent) ?? []), ...robotsTokens(pieces.join(","))]);
	}
	return [...groups]
		.filter(([, tokens]) => tokens.length > 0)
		.slice(0, SEO_MARKUP_LIMITS.values)
		.map(([name, tokens]) => ({
			agent: name.slice(0, SEO_MARKUP_LIMITS.exampleChars),
			tokens: tokens.slice(0, SEO_MARKUP_LIMITS.robotsTokens)
		}));
}

/**
 * Reads a viewport meta's content.
 *
 * @param content - The content as written.
 * @param inHead - Whether the tag sits in `<head>`.
 * @returns The properties it sets.
 */
export function parseViewport(content: string, inHead: boolean): SeoPageViewport {
	const values = new Map<string, string>();
	for (const part of content.split(/[,;]/)) {
		const [key, ...rest] = part.split("=");
		const name = (key ?? "").trim().toLowerCase();
		if (name !== "" && !values.has(name)) values.set(name, rest.join("=").trim());
	}
	const property = (name: string): string | null => {
		const value = values.get(name);
		return value === undefined ? null : short(value);
	};
	return {
		content: short(content),
		width: property("width"),
		initialScale: property("initial-scale"),
		minimumScale: property("minimum-scale"),
		maximumScale: property("maximum-scale"),
		userScalable: property("user-scalable"),
		inHead
	};
}

/**
 * Reads a refresh instruction, from a `<meta http-equiv="refresh">` or a `Refresh` header:
 * `5; url=/next` waits five seconds, then goes to `/next`.
 *
 * @param content - The content as written.
 * @param base - The URL a relative target resolves against.
 * @returns The delay in seconds (null when none is written) and the target (null when none).
 */
export function parseRefresh(
	content: string,
	base: string
): { delaySeconds: number | null; url: string | null } {
	const trimmed = content.trim();
	const delay = /^\d*(?:\.\d+)?/.exec(trimmed)?.[0] ?? "";
	const delaySeconds = delay === "" ? null : Number.parseFloat(delay);
	let target = trimmed.slice(delay.length).trim();
	if (target.startsWith(";") || target.startsWith(",")) target = target.slice(1).trim();
	if (/^url\s*=/i.test(target)) target = target.slice(target.indexOf("=") + 1).trim();
	target = target.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
	if (target === "") return { delaySeconds, url: null };
	return { delaySeconds, url: short(resolve(target, base) ?? target) };
}

/** Non-web schemes a link may rightly use. */
const OTHER_SCHEMES =
	/^(?:mailto|tel|sms|callto|skype|whatsapp|viber|geo|maps|fax|ftp|intent|market|itms[a-z-]*|facetime|bitcoin|magnet|webcal|news|irc|data):/i;

/**
 * Whether a link's scheme is a misspelt `http` or `https` (one letter added, dropped, changed or two
 * swapped: `htp`, `htps`, `htttp`, `httsp`). Any other scheme names an app the link opens (`vscode:`,
 * `slack:`, an editor's deep link to install a tool): browsers hand it to that app, and a crawler never
 * follows it.
 *
 * @param scheme - The scheme, lowercased, without its colon.
 * @returns Whether it is a misspelt web scheme.
 */
function misspeltWebScheme(scheme: string): boolean {
	return ["http", "https"].some((web) => {
		if (Math.abs(web.length - scheme.length) > 1) return false;
		const rows = scheme.length + 1;
		const cols = web.length + 1;
		const cost: number[] = Array.from({ length: rows * cols }, (_, at) =>
			at < cols ? at : at % cols === 0 ? at / cols : 0
		);
		const at = (row: number, col: number): number => cost[row * cols + col] ?? 0;
		for (let row = 1; row < rows; row += 1) {
			for (let col = 1; col < cols; col += 1) {
				const same = scheme[row - 1] === web[col - 1];
				let best = Math.min(
					at(row - 1, col) + 1,
					at(row, col - 1) + 1,
					at(row - 1, col - 1) + (same ? 0 : 1)
				);
				if (
					row > 1 &&
					col > 1 &&
					scheme[row - 1] === web[col - 2] &&
					scheme[row - 2] === web[col - 1]
				) {
					best = Math.min(best, at(row - 2, col - 2) + 1);
				}
				cost[row * cols + col] = best;
			}
		}
		return at(rows - 1, cols - 1) <= 1;
	});
}

/** Hosts that name the visitor's own machine. */
const LOCAL_HOST = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

/** An `onclick` that navigates. */
const NAVIGATING_SCRIPT =
	/\b(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\()/i;

/** A quoted URL or site path handed to a script (`openPage('/pricing')`). */
const QUOTED_TARGET = /["'](?:https?:\/\/|\/)[^"']*["']/i;

/**
 * The most script links held until the page's real links are known, and the most real link targets
 * kept to compare them with: a script that goes where a real link of the page also goes (a widget's
 * "Add to basket" button opening the product a card's link opens) leaves no page a crawler cannot reach.
 */
const MAX_SCRIPT_LINKS = 5_000;

/** A counter of the characters a reader looked at, for a caller that bounds or measures its work. */
export interface MarkupWork {
	steps: number;
}

/**
 * A path without its trailing slashes (a path of one character is kept). Read from the end once, so a
 * hostile path of a million slashes costs a million steps: an end-anchored pattern (`/\/+$/`) retries
 * from every slash of a run and costs its square.
 *
 * @param path - The path.
 * @param work - Counts the characters looked at, when given.
 * @returns The path without its trailing slashes.
 */
export function withoutTrailingSlashes(path: string, work?: MarkupWork): string {
	if (path.length <= 1) return path;
	let end = path.length;
	while (end > 0 && path.charCodeAt(end - 1) === 47) {
		if (work !== undefined) work.steps += 1;
		end -= 1;
	}
	return path.slice(0, end);
}

/**
 * A link target as two links to one page share it: the URL without its fragment, its host in lower
 * case and its path without a trailing slash.
 *
 * @param url - The absolute URL.
 * @returns The key, or null when it is no http(s) URL.
 */
function linkTargetKey(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		const path = withoutTrailingSlashes(parsed.pathname);
		return `${parsed.host.toLowerCase()}${path}${parsed.search}`;
	} catch {
		return null;
	}
}

/**
 * The page a script that navigates goes to (`location.href='/sofa/'`), keyed as {@link linkTargetKey}.
 *
 * @param code - The script, or a `javascript:` href.
 * @param base - The page's base URL.
 * @returns The key, or null when the script names no URL.
 */
function scriptTargetKey(code: string, base: string): string | null {
	const quoted = QUOTED_TARGET.exec(code)?.[0];
	if (quoted === undefined) return null;
	const resolved = resolve(quoted.slice(1, -1), base);
	return resolved === null ? null : linkTargetKey(resolved);
}

/**
 * Why a link's href cannot be crawled or leaks a local address. A `javascript:` href counts only when
 * it goes somewhere (it navigates, or hands a script a URL): one that does nothing (`void(0)`, a menu
 * toggle) is a button, not a link a crawler misses. A link in a non-web scheme (`tel:`, `mailto:`) is
 * never a crawler's to follow, so its spelling (a phone number written with spaces) is left alone; an
 * unknown scheme is filed only when it is a misspelt `http` (`htps:`), never an app's own (a deep link
 * that opens an editor or a chat app). Spaces before or after an address are dropped by every browser
 * and the URL standard, so only whitespace INSIDE it counts (the owner, 2026-10-07): a space in the path
 * (`/our team`) or only in the query string or fragment (`/search?q=two words`) is its own kind, since
 * browsers and search engines percent-encode it and open the page; an address that stays broken once its
 * spaces are encoded (a space in the host, a misspelt scheme) is judged as that breakage.
 *
 * @param raw - The href attribute as written.
 * @param base - The URL it resolves against.
 * @returns The kind, or null when the href is fine.
 */
function badHrefKind(raw: string, base: string): SeoPageBadLinkKindValue | null {
	const href = raw.trim();
	if (href === "") return "empty";
	if (/^javascript:/i.test(href)) {
		return NAVIGATING_SCRIPT.test(href) || QUOTED_TARGET.test(href) ? "javascript" : null;
	}
	if (/^file:/i.test(href) || /^\\\\/.test(href) || /^[a-z]:[\\/]/i.test(href)) return "file";
	if (OTHER_SCHEMES.test(href)) return null;
	if (/\s/.test(href)) {
		const broken = badHrefKind(href.replace(/\s/g, "%20"), base);
		if (broken !== null) return broken;
		return /\s/.test(href.split(/[?#]/, 1)[0] ?? "") ? "whitespace" : "whitespace_query";
	}
	if (/^https?:(?!\/\/)/i.test(href) || /^https?\/\//i.test(href) || href.includes("\\")) {
		return "malformed";
	}
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
	if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
		return misspeltWebScheme(scheme) ? "protocol" : null;
	}
	let url: URL;
	try {
		url = new URL(href, base);
	} catch {
		return "malformed";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.hostname === "") return "malformed";
	return LOCAL_HOST.test(url.hostname) ? "localhost" : null;
}

/**
 * A map's position kept in a fragment, which the map's script reads: numbers alone (`#8/48.5/9`,
 * `#47.59,12.99`), or after a name (`#geo:47.5941,12.9956`).
 */
const MAP_STATE = /^(?:[a-z]+:)?-?\d+(?:\.\d+)?(?:[/,]-?\d+(?:\.\d+)?)+$/i;

/**
 * A script's named command kept in a fragment, a word and a colon before its argument: a site
 * builder's script opens a popup or a menu from `#popup:contact-us` or `#submenu:more` and scrolls
 * nowhere.
 */
const SCRIPT_COMMAND = /^[a-z][\w-]*:\S/i;

/**
 * A fragment a bookmark check judges: not empty, not `top` (which scrolls to the top by the standard),
 * not a script router's state (`#/`, `#!`, `#key=value`, however it is encoded), a map's position, a
 * script's named command ({@link SCRIPT_COMMAND}) nor a text fragment. A link that runs a script when
 * clicked (`onclick`) is a button whose fragment nobody scrolls to.
 *
 * @param fragment - The fragment, without `#`.
 * @returns The fragment decoded, or null when it is not a bookmark.
 */
function bookmarkOf(fragment: string): string | null {
	let decoded = fragment;
	try {
		decoded = decodeURIComponent(fragment);
	} catch {
		decoded = fragment;
	}
	if (decoded === "" || decoded.includes("=") || /^(?:[!/?]|:~:)/.test(decoded)) return null;
	if (MAP_STATE.test(decoded) || SCRIPT_COMMAND.test(decoded)) return null;
	return decoded.toLowerCase() === "top" ? null : decoded;
}

/** A Google Analytics or Tag Manager loader URL, up to its query. */
const ANALYTICS_LOADER = /googletagmanager\.com\/(?:gtag\/js|gtm\.js)\?/i;

/**
 * A loader Tag Manager itself adds for a container already loaded (its own `gtm=` build parameter,
 * as on its tag diagnostics reload `gtm.js?id=GTM-X&is_td=1&gtm=...`): never a second install.
 */
const TAG_MANAGER_RELOAD = /[?&](?:amp;)?gtm=/i;

/** The id parameter of a loader's query. */
const ANALYTICS_ID_PARAM = /(?:^|&)id=((?:G|UA|GTM)-[A-Z0-9-]+)/i;

/**
 * The Google Analytics or Tag Manager id a script's loader URL names. Linear: the loader is found
 * first, then its query (up to a quote or a fragment) is read for the id, so a URL repeating the
 * loader many times is never rescanned from each copy.
 *
 * @param src - The script's `src`.
 * @returns The id, or undefined.
 */
function analyticsSrcId(src: string): string | undefined {
	const loader = ANALYTICS_LOADER.exec(src);
	if (loader === null) return undefined;
	const rest = src.slice(loader.index + loader[0].length);
	const end = rest.search(/["'#]/);
	return ANALYTICS_ID_PARAM.exec(end === -1 ? rest : rest.slice(0, end))?.[1];
}

/** Google Analytics and Tag Manager ids in an inline snippet. */
const ANALYTICS_INLINE =
	/(?:gtag\(\s*['"]config['"]\s*,\s*|ga\(\s*['"]create['"]\s*,\s*|['"]dataLayer['"]\s*,\s*)['"]((?:G|UA|GTM)-[A-Z0-9-]+)['"]/gi;

/** A `gtag('config', ...)` setting that sends no page view (an error or event tracker): it counts no visit. */
const NO_PAGE_VIEW = /^\s*,\s*\{[^)]*?['"]?send_page_view['"]?\s*:\s*(?:false|!1|0)\b/;

/**
 * A script type Partytown takes over (`text/partytown`, `text/partytown-x` once run): the browser
 * never runs it itself. Partytown runs it in a worker, or, where no service worker is offered (the
 * render offers none), runs a copy of it on the page, so the original names its ids but is no second
 * install of them.
 */
const HANDED_TO_WORKER = /^\s*text\/partytown(?:-x)?\s*$/i;

/**
 * A script that only hands a framework its page data (Next.js's `self.__next_f.push(...)`): a snippet
 * quoted in it is a copy of the page's own `<script>`, not code that runs.
 */
const FRAMEWORK_PAGE_DATA = /^\s*\(?self\.__next_f(?:=|\.push\()/;

/**
 * The Google Analytics and Tag Manager ids an inline script sets up to count visits: a config that
 * sends no page view is left out, so a tracker configured again for errors only never reads as the
 * page counting each visit twice, and a framework's page data quoting the snippet counts nothing.
 *
 * @param text - The script's text.
 * @returns The ids, once per setup.
 */
function inlineAnalyticsIds(text: string): string[] {
	if (FRAMEWORK_PAGE_DATA.test(text)) return [];
	const ids: string[] = [];
	for (const match of text.matchAll(ANALYTICS_INLINE)) {
		const id = match[1];
		if (id === undefined) continue;
		const after = text.slice(match.index + match[0].length, match.index + match[0].length + 400);
		if (match[0].startsWith("gtag") && NO_PAGE_VIEW.test(after)) continue;
		ids.push(id);
	}
	return ids;
}

/**
 * A placeholder text: the filler's own opening words, so a page that only mentions "lorem ipsum" in
 * its prose is never taken for one.
 */
const LOREM = /\blorem\s+ipsum\s+dolor\s+sit\b/i;

/**
 * The words of a control that puts a product in the cart, in the languages most stores use, compared
 * with the control's whole text once digits, punctuation and symbols are dropped (a price beside the
 * words is part of many such buttons).
 */
const ADD_TO_CART = new Set([
	"add to cart",
	"add to bag",
	"add to basket",
	"add to trolley",
	"add to shopping cart",
	"add to shopping bag",
	"in den warenkorb",
	"in den warenkorb legen",
	"ajouter au panier",
	"añadir al carrito",
	"agregar al carrito",
	"añadir a la cesta",
	"aggiungi al carrello",
	"adicionar ao carrinho",
	"toevoegen aan winkelwagen",
	"in winkelwagen",
	"lägg i varukorgen",
	"dodaj do koszyka",
	"læg i kurv",
	"læg i kurven",
	"legg i handlekurven",
	"lisää ostoskoriin",
	"do košíku",
	"vložit do košíku"
]);

/**
 * The attributes the common store platforms put on their add-to-cart control, whatever its words:
 * WooCommerce's single product button, PrestaShop's, Webflow's and Magento's.
 */
const ADD_TO_CART_MARKERS: readonly (readonly [string, string])[] = [
	["name", "add-to-cart"],
	["data-button-action", "add-to-cart"],
	["data-node-type", "commerce-add-to-cart-button"],
	["id", "product-addtocart-button"]
];

/**
 * A price as a page shows it: a currency sign or code beside an amount, either side. Read over a text
 * and the end of the text before it, so a sign in its own element (`<span>$</span>25.00`) counts. An
 * amount holds at most six thousands groups (a sextillion): an unbounded repeat would read a hostile
 * run of groups again from every group it holds, in the square of its length.
 */
const PRICE =
	/(?:[$€£¥₹₩₺₽]|\b(?:usd|eur|gbp|chf|cad|aud|nzd|sek|nok|dkk|pln|czk|huf|ron|zł|kr|r\$|rs\.?))\s?\d{1,3}(?:[.,\s']\d{3}){0,6}(?:[.,]\d{1,2})?(?!\d)|(?<![\d.,])\d{1,3}(?:[.,\s']\d{3}){0,6}(?:[.,]\d{1,2})?\s?(?:[$€£¥₹₺₽]|zł|kr\b|kč\b|lei\b|(?:usd|eur|gbp|chf|sek|nok|dkk|pln|czk)\b)/iu;

/** A form that puts a product in the cart, whatever its button says: Shopify's `/cart/add`. */
const CART_FORM_ACTION = /\/cart\/add(?:\.js)?(?:[?#]|$)/;

/**
 * Whether an element is a control that puts a product in the cart: a button, a submit input, a link
 * or an element with the button role, named by its words ({@link ADD_TO_CART}) or by a platform's
 * marker ({@link ADD_TO_CART_MARKERS}).
 *
 * @param element - The element.
 * @param attribs - Its attributes.
 * @returns Whether it is.
 */
function addToCartControl(element: Element, attribs: Record<string, string>): boolean {
	const tag = element.tagName;
	const type = (attribs.type ?? "").trim().toLowerCase();
	const control =
		tag === "button" ||
		tag === "a" ||
		(tag === "input" && (type === "submit" || type === "button")) ||
		(attribs.role ?? "").trim().toLowerCase() === "button";
	if (!control) return false;
	if (ADD_TO_CART_MARKERS.some(([name, value]) => (attribs[name] ?? "").trim() === value))
		return true;
	const words = (tag === "input" ? (attribs.value ?? "") : anchorTextOf(element))
		.toLowerCase()
		.replace(/[\p{N}\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return ADD_TO_CART.has(words);
}

/** `<link rel>` values whose target is a stylesheet, an icon or a preloaded file. */
const ICON_RELS = new Set([
	"icon",
	"shortcut",
	"apple-touch-icon",
	"apple-touch-icon-precomposed",
	"mask-icon"
]);

/** The Open Graph properties kept, by the field they fill. */
const OPEN_GRAPH_KEYS: Partial<Record<string, keyof SeoPageMarkupFacts["openGraph"]>> = {
	"og:title": "title",
	"og:type": "type",
	"og:image": "image",
	"og:url": "url",
	"og:description": "description",
	"og:site_name": "siteName"
};

/** The X (Twitter) card properties kept, by the field they fill. */
const CARD_KEYS: Partial<Record<string, keyof SeoPageMarkupFacts["twitter"]>> = {
	"twitter:card": "card",
	"twitter:title": "title",
	"twitter:description": "description",
	"twitter:image": "image",
	"twitter:site": "site"
};

/** Elements whose text is not page text. */
const NOT_TEXT = new Set(["script", "style", "noscript", "template", "textarea"]);

/** Elements that hold an article's running text. */
const PROSE = new Set(["p", "li", "pre", "code", "blockquote", "td", "dd", "figcaption"]);

/** Elements (and roles) of a page's chrome rather than its article: navigation, header, footer, asides. */
const CHROME = new Set(["nav", "header", "footer", "aside"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary"]);

/** How much of a text node the price test reads, and how much of the text before it. */
const PRICE_TEXT_CHARS = 2_000;
const PRICE_TAIL_CHARS = 24;

/** A frame of the walk. */
interface Frame {
	node: Node;
	inHead: boolean;
	inNoscript: boolean;
	/** Inside an element whose text is not page text. */
	notText: boolean;
	form: { password: boolean } | null;
	/** Inside a form that puts a product in the cart (counted once, whatever its controls). */
	cartForm: boolean;
	picture: { srcset: boolean } | null;
	/** Inside an `<article>` or `<main>`. */
	article: boolean;
	/** Inside the navigation, a header, a footer or an aside. */
	chrome: boolean;
	/** Inside a paragraph, a list item, a code block, a quote or a table cell. */
	prose: boolean;
}

/**
 * The site builder or framework a page's generator tag names, by its first words.
 *
 * @param generator - The generator tag's content.
 * @returns The platform, or null.
 */
function generatorPlatform(generator: string): SeoSitePlatformValue | null {
	const value = generator.trim().toLowerCase();
	if (value.startsWith("wordpress")) return "wordpress";
	if (value.includes("wix.com")) return "wix";
	if (value.includes("squarespace")) return "squarespace";
	if (/^ghost\b/.test(value)) return "ghost";
	if (value.startsWith("webflow")) return "webflow";
	if (value.includes("shopify")) return "shopify";
	if (value.startsWith("next.js")) return "nextjs";
	if (value.startsWith("discourse")) return "discourse";
	if (/^framer\b/.test(value)) return "framer";
	if (value.startsWith("joomla")) return "joomla";
	if (value.startsWith("prestashop")) return "prestashop";
	if (/^nuxt\b/.test(value)) return "nuxt";
	return null;
}

/**
 * The files only one platform serves, by host or path, checked in this order: a site built with a
 * framework may still show images from a content system (`/wp-content/` on a Next.js front end).
 */
const PLATFORM_FILES: readonly (readonly [SeoSitePlatformValue, RegExp])[] = [
	["shopify", /^https?:\/\/(?:cdn\.shopify\.com\/|[^/]+\/cdn\/(?:shop|shopifycloud)\/)/i],
	["squarespace", /^https?:\/\/[^/]*\bsquarespace(?:-cdn)?\.com\//i],
	["wix", /^https?:\/\/(?:static\.wixstatic\.com|static\.parastorage\.com)\//i],
	["webflow", /^https?:\/\/[^/]*\b(?:website-files\.com|webflow\.com)\//i],
	["nextjs", /^https?:\/\/[^/]+\/_next\/static\//i],
	["nuxt", /^https?:\/\/[^/]+\/_nuxt\//i],
	["framer", /^https?:\/\/framerusercontent\.com\/sites\//i],
	["prestashop", /^https?:\/\/[^/]+\/(?:themes\/core\.js|modules\/ps_[a-z]+\/)/i],
	["joomla", /^https?:\/\/[^/]+\/media\/(?:system\/js\/core|jui\/js\/)/i],
	["wordpress", /^https?:\/\/[^/]+\/wp-(?:content|includes)\//i]
];

/**
 * The site builder or framework a page shows it was made with: its generator tag first, else the files
 * it loads that only one platform serves, else a Webflow site's own attribute on `<html>`.
 *
 * @param generators - The generator tags' contents.
 * @param urls - The files the page loads, absolute.
 * @param webflowSite - Whether `<html>` carries Webflow's `data-wf-site`.
 * @returns The platform, or null.
 */
function platformOf(
	generators: readonly string[],
	urls: readonly string[],
	webflowSite: boolean
): SeoSitePlatformValue | null {
	for (const generator of generators) {
		const named = generatorPlatform(generator);
		if (named !== null) return named;
	}
	for (const [platform, pattern] of PLATFORM_FILES) {
		if (urls.some((url) => pattern.test(url))) return platform;
	}
	return webflowSite ? "webflow" : null;
}

/** A list of examples with a count. */
interface Counted {
	count: number;
	examples: string[];
}

/**
 * Counts an example in.
 *
 * @param into - The list.
 * @param example - The example.
 */
function countIn(into: Counted, example: string): void {
	into.count += 1;
	const cut = example.slice(0, SEO_MARKUP_LIMITS.exampleChars);
	if (into.examples.length < SEO_MARKUP_LIMITS.examples && !into.examples.includes(cut)) {
		into.examples.push(cut);
	}
}

/** The MIME types, file endings and ActiveX class ids of the plugins no browser runs any more. */
const LEGACY_PLUGIN =
	/x-shockwave-flash|futuresplash|x-silverlight|x-java|java-(?:applet|vm)|\.(?:swf|xap|jar|class)(?:$|[?#])|^clsid:(?:d27cdb6e-ae6d-11cf-96b8-444553540000|dfeaf541-f3e1-4c24-acac-99c30715084a|8ad9c840-044e-11d1-b3e9-00805f499d93)|^java:/i;

/**
 * Whether an `<object>` or `<embed>` needs a plugin no browser runs (Flash, Silverlight, a Java applet):
 * by its type, the file it loads, or its ActiveX class id.
 *
 * @param values - Its `type`, `data` or `src`, and `classid` attributes.
 * @returns Whether it does.
 */
function legacyPlugin(...values: (string | undefined)[]): boolean {
	return values.some((value) => value !== undefined && LEGACY_PLUGIN.test(value.trim()));
}

/**
 * The page's base URL: the first `<base href>` in the document, resolved, else the page.
 *
 * @param root - The document.
 * @param pageUrl - The page.
 * @returns The base URL.
 */
function baseOf(root: Node, pageUrl: string): string {
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) break;
		if ("tagName" in node && node.tagName === "base" && node.namespaceURI === HTML_NS) {
			const href = node.attrs.find((attr) => attr.name === "href")?.value;
			if (href !== undefined) return resolve(href, pageUrl) ?? pageUrl;
		}
		if ("childNodes" in node) {
			for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
				const child = node.childNodes[index];
				if (child !== undefined) stack.push(child);
			}
		}
	}
	return pageUrl;
}

/**
 * The child element of a parent by tag name.
 *
 * @param parent - The parent.
 * @param tag - The tag.
 * @returns The element, or undefined.
 */
function childElement(parent: Node | undefined, tag: string): Element | undefined {
	if (parent === undefined || !("childNodes" in parent)) return undefined;
	for (const child of parent.childNodes) {
		if ("tagName" in child && child.tagName === tag) return child;
	}
	return undefined;
}

/**
 * Whether the source offset lies inside a written `<noscript>`.
 *
 * @param lower - The source, lowercased.
 * @param offset - The offset.
 * @returns Whether it does.
 */
function insideNoscript(lower: string, offset: number): boolean {
	const before = lower.slice(0, offset);
	return before.lastIndexOf("<noscript") > before.lastIndexOf("</noscript");
}

/**
 * Whether a node is head metadata a page means for `<head>`: a title, a base, a named meta, or a
 * canonical, alternate, AMP or pagination link.
 *
 * @param node - The node.
 * @returns Whether it is.
 */
function headMetadata(node: Node): boolean {
	if (!("tagName" in node) || node.namespaceURI !== HTML_NS) return false;
	if (node.tagName === "title" || node.tagName === "base") return true;
	if (node.tagName === "meta") return node.attrs.some((attr) => attr.name === "name");
	return (
		node.tagName === "link" &&
		node.attrs.some(
			(attr) =>
				attr.name === "rel" && /\b(?:canonical|alternate|amphtml|next|prev)\b/i.test(attr.value)
		)
	);
}

/**
 * The element (or text) that ended `<head>` early: the first node the parser placed in `<body>` that
 * the source wrote before its `</head>` or `<body>` tag. With neither tag written, the first body node
 * that comes before a head-only element the parser also moved into `<body>`.
 *
 * @param html - The source.
 * @param body - The parsed `<body>`.
 * @param headEnd - Where the source ends its head, or null.
 * @returns The breaker, or null.
 */
function headBreaker(
	html: string,
	body: Element | undefined,
	headEnd: number | null
): SeoPageHeadFacts["breaker"] {
	if (body === undefined) return null;
	let first: Node | undefined;
	let movedMetadata = false;
	const stack: Node[] = [...body.childNodes].reverse();
	let seen = 0;
	while (stack.length > 0 && seen < 10_000 && !movedMetadata) {
		const node = stack.pop();
		if (node === undefined) break;
		seen += 1;
		if (node.nodeName === "#comment") continue;
		if (node.nodeName === "#text" && "value" in node && node.value.trim() === "") continue;
		if (first === undefined) {
			first = node;
			if (headEnd !== null) break;
		} else if (headMetadata(node)) {
			movedMetadata = true;
		}
		if ("childNodes" in node) {
			for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
				const child = node.childNodes[index];
				if (child !== undefined) stack.push(child);
			}
		}
	}
	const offset = first?.sourceCodeLocation?.startOffset;
	if (first === undefined || offset === undefined) return null;
	if (headEnd === null ? !movedMetadata : offset >= headEnd) return null;
	return {
		tag: "tagName" in first ? first.tagName.slice(0, 64) : "#text",
		line: first.sourceCodeLocation?.startLine ?? 0,
		inNoscript: insideNoscript(html.toLowerCase(), offset)
	};
}

/**
 * READS THE MARKUP of one page.
 *
 * @param html - The page's HTML: as served, or as a browser rendered it.
 * @param pageUrl - The URL it was read at.
 * @param options.rendered - Whether `html` is a browser's rendered DOM (parsed with scripting on).
 * @param options.source - The document tags the extractor's token pass counted.
 * @returns The markup facts and the subresources the page references.
 */
export function extractMarkup(
	html: string,
	pageUrl: string,
	options: { rendered: boolean; source: MarkupSourceTags }
): ExtractedMarkup {
	const limits = SEO_MARKUP_LIMITS;
	const parsed = parseWithinBudget(html, options.rendered);
	const document = parsed.document;
	const htmlElement = childElement(document, "html");
	const head = childElement(htmlElement, "head");
	const body = childElement(htmlElement, "body");
	const base = baseOf(document, pageUrl);
	const pageWithoutHash = pageUrl.split("#")[0] ?? pageUrl;

	const facts: ExtractedMarkup = {
		head: {
			htmlTags: options.source.html,
			headTags: options.source.head,
			bodyTags: options.source.body,
			contentBeforeHtml: options.source.contentBeforeHtml,
			headNotFirst: options.source.head > 0 && head?.sourceCodeLocation?.startTag == null,
			breaker: headBreaker(html, body, options.source.headEnd)
		},
		titles: [],
		descriptions: [],
		robots: [],
		canonicals: [],
		hreflangOutsideHead: 0,
		bases: [],
		refresh: [],
		viewports: [],
		lang: { html: null, contentLanguage: null },
		openGraph: {
			title: null,
			type: null,
			image: null,
			url: null,
			description: null,
			siteName: null
		},
		twitter: { card: null, title: null, description: null, image: null, site: null },
		badLinks: [],
		bookmarks: { missing: [], missingCount: 0, external: [], ids: [], idsTruncated: false },
		forms: [],
		formCount: 0,
		passwordOutsideForm: false,
		images: [],
		imageCount: 0,
		pagination: { next: [], prev: [] },
		amp: { isAmp: false, amphtml: null },
		mobileAlternate: null,
		analytics: { ids: [], duplicates: [] },
		loremIpsum: null,
		plugins: { object: 0, embed: 0, applet: 0, imageMaps: 0, legacy: 0 },
		ajaxFragmentMeta: false,
		protocolRelative: { count: 0, examples: [] },
		skeleton: layoutSkeleton(body),
		markdownAlternate: null,
		resources: []
	};
	if (htmlElement !== undefined) {
		const attribs = attributesOf(htmlElement);
		facts.lang.html = attribs.lang === undefined ? null : short(attribs.lang);
		facts.amp.isAmp = "amp" in attribs || "⚡" in attribs;
	}
	const webflowSite = htmlElement !== undefined && "data-wf-site" in attributesOf(htmlElement);
	const generators: string[] = [];

	const badLinks = new Map<
		SeoPageBadLinkKindValue,
		Counted & { anchors: string[]; inText: number }
	>();
	const badLink = (
		kind: SeoPageBadLinkKindValue,
		example: string,
		anchor: string,
		inText = false
	): void => {
		const held = badLinks.get(kind) ?? { count: 0, examples: [], anchors: [], inText: 0 };
		held.count += 1;
		if (inText) held.inText += 1;
		const cut = example.slice(0, limits.exampleChars);
		const known = held.examples.some(
			(entry, index) => entry === cut && held.anchors[index] === anchor
		);
		if (!known && held.examples.length < limits.examples) {
			held.examples.push(cut);
			held.anchors.push(anchor);
		}
		badLinks.set(kind, held);
	};
	const linked = new Set<string>();
	const scripted: {
		kind: SeoPageBadLinkKindValue;
		example: string;
		anchor: string;
		target: string | null;
	}[] = [];
	const scriptLink = (kind: SeoPageBadLinkKindValue, example: string, anchor: string): void => {
		const target = scriptTargetKey(example, base);
		if (target === null || scripted.length >= MAX_SCRIPT_LINKS) badLink(kind, example, anchor);
		else scripted.push({ kind, example, anchor, target });
	};
	const sentences = sentenceJudge();
	const ids = new Set<string>();
	const samePage: string[] = [];
	const external = new Map<string, { url: string; fragment: string }>();
	const resources = new Map<string, ExtractedResourceKind>();
	const resource = (raw: string | undefined, kind: ExtractedResourceKind): void => {
		if (raw === undefined) return;
		if (/^\s*\/\/[^/]/.test(raw)) countIn(facts.protocolRelative, raw.trim());
		const url = resolveHttp(raw, base);
		if (url === null || resources.has(url) || resources.size >= limits.resources) return;
		if (url.length <= limits.resourceChars) resources.set(url, kind);
	};
	const srcsetResources = (srcset: string | undefined, kind: ExtractedResourceKind): void => {
		if (srcset === undefined) return;
		for (const url of srcsetUrls(srcset)) resource(url, kind);
	};
	const analyticsSrc = new Map<string, number>();
	const analyticsInline = new Map<string, number>();
	const tally = (into: Map<string, number>, id: string): void => {
		const key = id.toUpperCase().slice(0, 64);
		into.set(key, (into.get(key) ?? 0) + 1);
	};

	const commerce = { cartButtons: 0, price: false };
	let textTail = "";
	const stack: Frame[] = [
		{
			node: document,
			inHead: false,
			inNoscript: false,
			notText: false,
			form: null,
			cartForm: false,
			picture: null,
			article: false,
			chrome: false,
			prose: false
		}
	];
	while (stack.length > 0) {
		const frame = stack.pop();
		if (frame === undefined) break;
		const { node } = frame;
		if (node.nodeName === "#text" && "value" in node) {
			if (facts.loremIpsum === null && !frame.notText && LOREM.test(node.value)) {
				const at = node.value.search(LOREM);
				facts.loremIpsum = short(node.value.slice(Math.max(0, at - 40), at + 80), 160);
			}
			if (!frame.notText && !frame.inHead && node.value.trim() !== "") {
				if (!commerce.price && PRICE.test(`${textTail} ${node.value.slice(0, PRICE_TEXT_CHARS)}`))
					commerce.price = true;
				textTail = node.value.trim().slice(-PRICE_TAIL_CHARS);
			}
			continue;
		}
		if (!("tagName" in node)) {
			if ("childNodes" in node) {
				for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
					const child = node.childNodes[index];
					if (child !== undefined) stack.push({ ...frame, node: child });
				}
			}
			continue;
		}
		const element = node;
		const tag = element.tagName;
		const isHtml = element.namespaceURI === HTML_NS;
		const attribs = attributesOf(element);
		const inHead = frame.inHead || (isHtml && tag === "head");
		const inNoscript = frame.inNoscript || (isHtml && tag === "noscript");
		const notText = frame.notText || (isHtml && NOT_TEXT.has(tag));
		const article = frame.article || (isHtml && (tag === "article" || tag === "main"));
		const chrome =
			frame.chrome ||
			(isHtml && (CHROME.has(tag) || CHROME_ROLES.has((attribs.role ?? "").trim().toLowerCase())));
		const prose = frame.prose || (isHtml && PROSE.has(tag));
		let form = frame.form;
		let cartForm = frame.cartForm;
		let picture = frame.picture;
		if (attribs.id !== undefined && attribs.id !== "") ids.add(attribs.id);
		if (isHtml && !frame.inNoscript) {
			const rel = (attribs.rel ?? "")
				.toLowerCase()
				.split(/\s+/)
				.filter((word) => word !== "");
			switch (tag) {
				case "title":
					if (facts.titles.length < limits.values) {
						const text = element.childNodes
							.map((child) => ("value" in child ? child.value : ""))
							.join("");
						facts.titles.push({ text: short(text), inHead });
					}
					break;
				case "meta": {
					const name = (attribs.name ?? "").trim().toLowerCase();
					const property = (attribs.property ?? attribs.name ?? "").trim().toLowerCase();
					const httpEquiv = (attribs["http-equiv"] ?? "").trim().toLowerCase();
					const content = attribs.content ?? "";
					if (name === "description" && facts.descriptions.length < limits.values) {
						facts.descriptions.push({ text: short(content), inHead });
					} else if (ROBOTS_META_NAME.test(name) && facts.robots.length < limits.values) {
						facts.robots.push({ agent: short(name), tokens: robotsTokens(content), inHead });
					} else if (name === "viewport" && facts.viewports.length < limits.values) {
						facts.viewports.push(parseViewport(content, inHead));
					} else if (name === "fragment" && content.trim() === "!") {
						facts.ajaxFragmentMeta = true;
					} else if (name === "generator" && generators.length < limits.values) {
						generators.push(content);
					}
					if (httpEquiv === "refresh" && facts.refresh.length < limits.values) {
						facts.refresh.push({ content: short(content), ...parseRefresh(content, base), inHead });
					} else if (httpEquiv === "content-language") {
						facts.lang.contentLanguage ??= short(content);
					}
					const ogKey = OPEN_GRAPH_KEYS[property];
					const cardKey = CARD_KEYS[property];
					if (ogKey !== undefined) facts.openGraph[ogKey] ??= short(content);
					if (cardKey !== undefined) facts.twitter[cardKey] ??= short(content);
					if (property === "og:image" || property === "twitter:image")
						resource(content, "og_image");
					break;
				}
				case "link": {
					const href = attribs.href;
					if (rel.includes("canonical") && facts.canonicals.length < limits.values) {
						facts.canonicals.push({
							href: short(href ?? ""),
							inHead,
							attributes: ["hreflang", "lang", "media", "type"].filter((name) => name in attribs)
						});
					}
					if (rel.includes("alternate") && attribs.hreflang !== undefined && !inHead) {
						facts.hreflangOutsideHead += 1;
					}
					if (
						rel.includes("alternate") &&
						attribs.media !== undefined &&
						attribs.hreflang === undefined &&
						href !== undefined &&
						facts.mobileAlternate === null
					) {
						const url = resolveHttp(href, base);
						if (url !== null)
							facts.mobileAlternate = { url: short(url), media: short(attribs.media) };
					}
					if (rel.includes("amphtml") && href !== undefined) {
						facts.amp.amphtml ??= short(resolveHttp(href, base) ?? href);
					}
					if (
						rel.includes("alternate") &&
						href !== undefined &&
						/^text\/(?:x-)?markdown\b/i.test(attribs.type ?? "") &&
						facts.markdownAlternate == null
					) {
						facts.markdownAlternate = short(resolveHttp(href, base) ?? href);
					}
					const pages = rel.includes("next")
						? facts.pagination.next
						: rel.includes("prev") || rel.includes("previous")
							? facts.pagination.prev
							: null;
					if (pages !== null && href !== undefined && pages.length < limits.pagination) {
						pages.push(short(resolveHttp(href, base) ?? href));
					}
					const as = (attribs.as ?? "").toLowerCase();
					if (rel.includes("stylesheet")) resource(href, "stylesheet");
					else if (rel.some((word) => ICON_RELS.has(word))) resource(href, "icon");
					else if (rel.includes("preload") || rel.includes("modulepreload")) {
						const kind: Record<string, ExtractedResourceKind> = {
							font: "font",
							style: "stylesheet",
							script: "script",
							image: "image"
						};
						const preloaded = rel.includes("modulepreload") ? "script" : kind[as];
						if (preloaded !== undefined) resource(href, preloaded);
					}
					break;
				}
				case "base":
					if (facts.bases.length < limits.values) {
						facts.bases.push({
							href: attribs.href === undefined ? null : short(attribs.href),
							inHead
						});
					}
					break;
				case "script": {
					const src = attribs.src;
					const handedOver = HANDED_TO_WORKER.test(attribs.type ?? "");
					if (src !== undefined) {
						resource(src, "script");
						const id = analyticsSrcId(src);
						if (id !== undefined && (handedOver || TAG_MANAGER_RELOAD.test(src)))
							analyticsSrc.set(id, analyticsSrc.get(id) ?? 0);
						else if (id !== undefined) tally(analyticsSrc, id);
					} else {
						const text = element.childNodes
							.map((child) => ("value" in child ? child.value : ""))
							.join("");
						for (const id of inlineAnalyticsIds(text)) {
							if (handedOver) analyticsInline.set(id, analyticsInline.get(id) ?? 0);
							else tally(analyticsInline, id);
						}
					}
					break;
				}
				case "img": {
					if (attribs.usemap !== undefined) facts.plugins.imageMaps += 1;
					const shown = imageSource(attribs);
					if (shown !== "") resource(shown, "image");
					srcsetResources(attribs.srcset, "image");
					if (imageHidden(attribs)) break;
					facts.imageCount += 1;
					if (facts.images.length < limits.images) {
						const image: SeoPageMarkupImage = {
							src: imageSource(attribs).slice(0, limits.exampleChars),
							alt: attribs.alt === undefined ? null : short(attribs.alt, 200),
							altLength: attribs.alt?.trim().length ?? 0,
							srcset:
								(attribs.srcset ?? attribs["data-srcset"] ?? "").trim() !== "" ||
								picture?.srcset === true,
							sizes: (attribs.sizes ?? "").trim() !== "",
							loading:
								attribs.loading === undefined ? null : short(attribs.loading.toLowerCase(), 20),
							fetchPriority:
								attribs.fetchpriority === undefined
									? null
									: short(attribs.fetchpriority.toLowerCase(), 20),
							width: attribs.width === undefined ? null : short(attribs.width, 20),
							height: attribs.height === undefined ? null : short(attribs.height, 20)
						};
						facts.images.push(image);
					}
					break;
				}
				case "picture":
					picture = { srcset: false };
					break;
				case "source":
					if (picture !== null && (attribs.srcset ?? "").trim() !== "") picture.srcset = true;
					srcsetResources(attribs.srcset, picture === null ? "media" : "image");
					resource(attribs.src, "media");
					break;
				case "video":
					resource(attribs.src, "media");
					resource(attribs.poster, "image");
					break;
				case "audio":
				case "track":
					resource(attribs.src, "media");
					break;
				case "iframe":
					if (attribs.src !== undefined && /^\s*\/\/[^/]/.test(attribs.src)) {
						countIn(facts.protocolRelative, attribs.src.trim());
					}
					break;
				case "object":
					facts.plugins.object += 1;
					if (legacyPlugin(attribs.type, attribs.data, attribs.classid))
						facts.plugins.legacy = (facts.plugins.legacy ?? 0) + 1;
					break;
				case "embed":
					facts.plugins.embed += 1;
					if (legacyPlugin(attribs.type, attribs.src))
						facts.plugins.legacy = (facts.plugins.legacy ?? 0) + 1;
					break;
				case "applet":
					facts.plugins.applet += 1;
					break;
				case "form":
					facts.formCount += 1;
					form = { password: false };
					if (CART_FORM_ACTION.test(attribs.action ?? "")) {
						cartForm = true;
						commerce.cartButtons += 1;
					}
					if (facts.forms.length < limits.forms) {
						const action = attribs.action?.trim() ?? "";
						const entry = {
							action: short(action === "" ? pageWithoutHash : (resolve(action, base) ?? action)),
							method: short((attribs.method ?? "get").toLowerCase(), 20),
							password: false
						};
						facts.forms.push(entry);
						form = entry;
					}
					break;
				case "input":
					if ((attribs.type ?? "").trim().toLowerCase() === "password") {
						if (form === null) facts.passwordOutsideForm = true;
						else form.password = true;
					}
					break;
				default:
					break;
			}
			if (tag === "a" || tag === "area") {
				if (tag === "a" && attribs.name !== undefined && attribs.name !== "") ids.add(attribs.name);
				const href = attribs.href;
				const scriptHref = href !== undefined && /^\s*javascript:/i.test(href);
				if (href === undefined || (scriptHref && badHrefKind(href, base) === null)) {
					if (tag === "a" && NAVIGATING_SCRIPT.test(attribs.onclick ?? "")) {
						scriptLink("onclick", attribs.onclick ?? "", anchorTextOf(element));
					}
				} else {
					const kind = badHrefKind(href, base);
					if (kind === "javascript") scriptLink(kind, href, anchorTextOf(element));
					else if (kind !== null) {
						const inText =
							frame.article && !frame.chrome && (frame.prose || sentences.inSentence(element));
						badLink(kind, href, anchorTextOf(element), inText);
					} else {
						const resolved = resolve(href, base);
						const key =
							resolved === null || linked.size >= MAX_SCRIPT_LINKS ? null : linkTargetKey(resolved);
						if (key !== null) linked.add(key);
						const hash = resolved?.indexOf("#") ?? -1;
						const fragment =
							resolved !== null && hash >= 0 && (attribs.onclick ?? "").trim() === ""
								? bookmarkOf(resolved.slice(hash + 1))
								: null;
						if (resolved !== null && fragment !== null && /^https?:/i.test(resolved)) {
							const target = resolved.slice(0, hash);
							if (target === pageWithoutHash) samePage.push(fragment);
							else if (external.size < limits.externalBookmarks) {
								external.set(`${target}#${fragment}`, {
									url: short(target, limits.exampleChars),
									fragment: fragment.slice(0, limits.idChars)
								});
							}
						}
					}
				}
			} else if (NAVIGATING_SCRIPT.test(attribs.onclick ?? "")) {
				scriptLink("onclick", `<${tag}> ${attribs.onclick ?? ""}`, anchorTextOf(element));
			}
		}
		if (isHtml && !cartForm && !frame.inNoscript && !inHead && addToCartControl(element, attribs))
			commerce.cartButtons += 1;
		if (isHtml && tag === "template") continue;
		for (let index = element.childNodes.length - 1; index >= 0; index -= 1) {
			const child = element.childNodes[index];
			if (child !== undefined)
				stack.push({
					node: child,
					inHead,
					inNoscript,
					notText,
					form,
					cartForm,
					picture,
					article,
					chrome,
					prose
				});
		}
	}

	for (const link of scripted) {
		if (link.target === null || !linked.has(link.target))
			badLink(link.kind, link.example, link.anchor);
	}
	facts.badLinks = [...badLinks].map(([kind, { inText, ...counted }]) => ({
		kind,
		...counted,
		...(inText > 0 ? { inText } : {})
	}));
	facts.platform = platformOf(generators, [...resources.keys()], webflowSite);
	facts.commerce = commerce;
	const missing = [...new Set(samePage)].filter((fragment) => !ids.has(fragment));
	facts.bookmarks = {
		missing: missing.slice(0, limits.examples).map((fragment) => fragment.slice(0, limits.idChars)),
		missingCount: missing.length,
		external: [...external.values()],
		ids: [...ids].slice(0, limits.ids).map((id) => id.slice(0, limits.idChars)),
		idsTruncated: ids.size > limits.ids
	};
	const analyticsIds = new Set([...analyticsSrc.keys(), ...analyticsInline.keys()]);
	facts.analytics = {
		ids: [...analyticsIds].slice(0, limits.analyticsIds),
		duplicates: [...analyticsIds]
			.filter(
				(id) =>
					(analyticsInline.get(id) ?? 0) > 1 ||
					(id.toUpperCase().startsWith("GTM-") && (analyticsSrc.get(id) ?? 0) > 1)
			)
			.slice(0, limits.analyticsIds)
	};
	facts.resources = [...resources].map(([url, kind]): ExtractedResource => ({ url, kind }));
	const structured = readStructuredData(document, base);
	facts.structuredItems = structured.items;
	facts.markedValues = structured.markedValues;
	if (structured.truncated) facts.structuredTruncated = true;
	if (parsed.cut) facts.parseCut = true;
	return facts;
}
