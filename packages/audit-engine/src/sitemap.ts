import { Parser } from "htmlparser2";

import { MARKUP_MAX_DEPTH } from "./markup-depth";

/**
 * Sitemaps, ported from LibreCrawl's `sitemap_parser.py`: the `Sitemap:` lines of robots.txt plus the
 * common paths, sitemap indexes followed, gzip unpacked, namespaces ignored. Bounded by a file count
 * and a URL count so a site with a million-URL sitemap costs what the caps allow and no more. A file
 * is read as its bytes arrive (`readSitemapStream`), so memory stays flat up to the protocol's 50 MB.
 *
 * Beside the URLs, the parse keeps what the site audit's sitemap file rules judge: the root element
 * and its namespace, `<lastmod>` values that are not W3C Datetime, the tags Google ignores, and the
 * image, video and news extensions' limits. Facts only; `./rules/sitemap` judges them.
 */

/**
 * The paths tried on a site whose robots.txt names no sitemap: the usual names, plus the defaults of
 * WordPress itself (`/wp-sitemap.xml`), of Astro and Next.js sitemap plugins (`/sitemap-index.xml`)
 * and of BigCommerce stores (`/xmlsitemap.php`, which a store's own robots.txt may leave out).
 */
export const COMMON_SITEMAP_PATHS = [
	"/sitemap.xml",
	"/sitemap_index.xml",
	"/sitemap-index.xml",
	"/wp-sitemap.xml",
	"/sitemaps.xml",
	"/sitemap/sitemap.xml",
	"/xmlsitemap.php"
] as const;

/** The XHTML namespace a sitemap's `xhtml:link` alternates must be declared in. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** The most alternates one sitemap entry keeps, and the examples of an incomplete set kept. */
const MAX_ALTERNATES = 1_000;
const HREFLANG_EXAMPLES = 5;

/** The characters of an example URL kept (a `<loc>` may be as long as the file). */
const EXAMPLE_CHARS = 2_048;

/**
 * The characters of one element's text the parser holds: far above any valid `<loc>` (under 2,048
 * characters) and its indentation, so text between two tags never grows with the file.
 */
const MAX_TEXT_CHARS = 8_192;

/**
 * The entries one file keeps (sitemaps.org's limit per file), and the nested sitemaps an index keeps:
 * a longer file is counted whole, and is too big already (`sitemap_too_big`).
 */
export const SITEMAP_KEPT_URLS = 50_000;

/**
 * The hreflang alternates one file keeps in all: an entry that starts past it keeps none and is not
 * judged, so a file of any size holds a bounded set.
 */
const SITEMAP_KEPT_ALTERNATES = 200_000;

/** The `<news:publication_date>` values one entry keeps (a news entry states one). */
const MAX_NEWS_DATES = 10;

/** What a sitemap's hreflang alternates (`<xhtml:link rel="alternate" hreflang>`) showed. */
export interface SitemapHreflang {
	/** Page entries that carry alternates. */
	urls: number;
	/** Whether an alternate was written without the XHTML namespace declared for it. */
	namespaceMissing: boolean;
	/** Entries whose set leaves out the entry itself, or differs from the set a listed alternate carries. */
	incomplete: number;
	/** A few of those entries' URLs. */
	examples: string[];
}

/**
 * A short fingerprint of a set of URLs, the same for the same set in any order.
 *
 * @param urls - The set.
 * @returns The fingerprint.
 */
function setPrint(urls: ReadonlySet<string>): string {
	let hash = 2_166_136_261;
	for (const url of [...urls].sort()) {
		for (let index = 0; index < url.length; index += 1) {
			hash ^= url.charCodeAt(index);
			hash = Math.imul(hash, 16_777_619) >>> 0;
		}
		hash = Math.imul(hash ^ 10, 16_777_619) >>> 0;
	}
	return `${String(urls.size)}:${String(hash)}`;
}

/**
 * Judges the hreflang sets a sitemap's entries carry: each must list itself, and each alternate the
 * file also lists must carry the same set.
 *
 * @param sets - Each entry's URL and the alternates it lists.
 * @param namespaceMissing - Whether an alternate's namespace was not declared.
 * @returns The facts, or undefined when no entry carries alternates.
 */
function hreflangFacts(
	sets: ReadonlyMap<string, Set<string>>,
	namespaceMissing: boolean
): SitemapHreflang | undefined {
	if (sets.size === 0 && !namespaceMissing) return undefined;
	const prints = new Map([...sets].map(([loc, set]) => [loc, setPrint(set)]));
	const incomplete: string[] = [];
	let incompleteCount = 0;
	for (const [loc, set] of sets) {
		const own = prints.get(loc);
		const broken =
			!set.has(loc) ||
			[...set].some((alt) => alt !== loc && prints.has(alt) && prints.get(alt) !== own);
		if (!broken) continue;
		incompleteCount += 1;
		if (incomplete.length < HREFLANG_EXAMPLES) incomplete.push(loc.slice(0, EXAMPLE_CHARS));
	}
	return {
		urls: sets.size,
		namespaceMissing,
		incomplete: incompleteCount,
		examples: incomplete
	};
}

/**
 * The namespaces a sitemap or sitemap index may declare: sitemaps.org's, and the one Google's first
 * protocol defined (0.84), which Google kept accepting when the protocol moved to sitemaps.org (Google
 * Search Central blog, 2006-11-16) and older generators still write.
 */
const SITEMAP_NAMESPACES: ReadonlySet<string> = new Set([
	"http://www.sitemaps.org/schemas/sitemap/0.9",
	"http://www.google.com/schemas/sitemap/0.84"
]);

/** The most images Google reads for one URL of an image sitemap. */
export const SITEMAP_MAX_IMAGES_PER_URL = 1000;

/** A W3C Datetime (a year, a month, a day, or a time with an optional zone designator). */
const W3C_DATETIME =
	/^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/** The tags of a `<url>` entry that Google ignores. */
const DEPRECATED_TAGS = new Set(["priority", "changefreq"]);

/** The image extension tags Google stopped reading (2022). */
const DEPRECATED_IMAGE_TAGS = new Set(["caption", "title", "geo_location", "license"]);

/** The video extension tags every `<video:video>` needs. */
const VIDEO_REQUIRED = ["thumbnail_loc", "title", "description"] as const;

/** What one `<url>` entry of a sitemap states beyond its URL. */
export interface ParsedSitemapEntry {
	/** The `<lastmod>` as written, or null. */
	lastmod: string | null;
	/** Whether it carries a tag Google ignores (`priority`, `changefreq`, a retired image tag). */
	deprecated: boolean;
	/** How many `<image:image>` it lists. */
	images: number;
	/** How many `<video:video>` lack a required tag (a thumbnail, a title, a description, a content or player URL). */
	videosIncomplete: number;
	/** Each `<news:publication_date>` as written. */
	newsDates: string[];
}

/** One parsed sitemap file. */
export interface ParsedSitemap {
	/** Page URLs (`<url><loc>`), the first {@link SITEMAP_KEPT_URLS}. */
	urls: string[];
	/** Every page URL the file lists, kept or not. */
	listed: number;
	/** Each page URL's `<lastmod>` day (`YYYY-MM-DD`), or null when it has none; aligned with `urls`. */
	lastmods: (string | null)[];
	/** Each page URL's extra facts; aligned with `urls`. */
	entries: ParsedSitemapEntry[];
	/** Nested sitemaps (`<sitemap><loc>`). */
	sitemaps: string[];
	/**
	 * The root element's local name (`urlset`, `sitemapindex`, or a feed's `rss` or `feed`), `text`
	 * for a plain list of URLs, or null when it is none of them.
	 */
	root: string | null;
	/** Whether the root declares a sitemap namespace (a feed or a text list needs none). */
	namespaced: boolean;
	/** Whether the XML is well formed: every element closed, in order (a cut or broken file is not). */
	wellFormed: boolean;
	/** The hreflang alternates its entries carry, or undefined when none does. */
	hreflang?: SitemapHreflang;
}

/**
 * Whether a `<lastmod>` value is a W3C Datetime that names a real day and time (`2026-13-45` has the
 * shape but is no date).
 *
 * @param value - The value as written.
 * @returns Whether it is one.
 */
export function validLastmod(value: string): boolean {
	const trimmed = value.trim();
	if (!W3C_DATETIME.test(trimmed)) return false;
	const [, year = "", month = "01", day = "01", hour = "00", minute = "00", second = "00"] =
		/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(trimmed) ?? [];
	const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
	return (
		!Number.isNaN(date.getTime()) &&
		date.getUTCMonth() + 1 === Number(month) &&
		date.getUTCDate() === Number(day) &&
		Number(hour) < 24 &&
		Number(minute) < 60 &&
		Number(second) < 60
	);
}

/** The sitemap roots search engines read: the sitemap protocol's two, the two feed formats, text. */
export const SITEMAP_ROOTS: ReadonlySet<string> = new Set([
	"urlset",
	"sitemapindex",
	"rss",
	"feed",
	"text"
]);

/**
 * One entry's facts when the file states nothing beyond its URL (a feed item, a line of text).
 *
 * @returns The facts.
 */
function bareEntry(): ParsedSitemapEntry {
	return { lastmod: null, deprecated: false, images: 0, videosIncomplete: 0, newsDates: [] };
}

/**
 * A copy of a string that holds none of the text it was cut from. The parser hands over slices of the
 * chunk they came from, and V8 keeps a whole chunk alive while one slice of it is kept (V8 issue 2869);
 * joining a character first makes V8 copy the characters, so a URL kept costs its own length only.
 *
 * @param value - A piece of the parsed text.
 * @returns The same characters, standing alone.
 */
function own(value: string): string {
	return value === "" ? value : ` ${value}`.slice(1);
}

/** A URL line of a plain text sitemap. */
const TEXT_URL = /^https?:\/\/\S+$/i;

/** A sitemap parse fed its text a piece at a time. */
interface SitemapTextParser {
	/**
	 * Takes the next piece of the text.
	 *
	 * @returns Whether the parse takes more: false once the file nests deeper than any sitemap.
	 */
	write(text: string): boolean;
	/**
	 * Ends the parse.
	 *
	 * @param cut - Whether the text stopped at a cap before the file's end: the entry it stopped in is
	 *   dropped, never closed, so a URL cut short is never read as one.
	 */
	end(cut?: boolean): ParsedSitemap;
}

/**
 * The plain text half of a parse: one absolute URL per line, nothing else (sitemaps.org's text
 * format). It stops listening at the first line that is no URL, or longer than any URL.
 *
 * @returns The parser; `end` answers its URLs, or null when the text is no such list.
 */
function textSitemapParser(): {
	write(text: string): void;
	end(cut: boolean): { urls: string[]; listed: number } | null;
} {
	const lines: string[] = [];
	let listed = 0;
	let partial = "";
	let failed = false;
	const take = (line: string): void => {
		const url = line.trim();
		if (url === "") return;
		if (!TEXT_URL.test(url)) {
			failed = true;
			return;
		}
		listed += 1;
		if (lines.length < SITEMAP_KEPT_URLS) lines.push(own(url));
	};
	return {
		write(text) {
			if (failed) return;
			const pieces = (partial + text).split("\n");
			partial = pieces.pop() ?? "";
			for (const piece of pieces) {
				take(piece);
				if (failed) return;
			}
			if (partial.length > MAX_TEXT_CHARS) failed = true;
		},
		end(cut) {
			if (!failed && !cut) take(partial);
			return failed || listed === 0 ? null : { urls: lines, listed };
		}
	};
}

/**
 * A parse of one sitemap or sitemap index, an RSS or Atom feed (Google reads both as sitemaps: each
 * item's link is a page), or a plain text list of URLs, fed its text a piece at a time so a file is
 * never held whole. Anything else yields nothing. A file nested deeper than any sitemap is read only to
 * that depth ({@link MARKUP_MAX_DEPTH}) and is not well formed.
 *
 * Memory stays flat whatever the file's size: the parse keeps the first {@link SITEMAP_KEPT_URLS}
 * entries (counting the rest), the hreflang alternates of entries up to
 * {@link SITEMAP_KEPT_ALTERNATES} in all (an entry past it is left unjudged), and every kept value as
 * its own copy, never a slice of the text.
 *
 * @returns The parser.
 */
function sitemapTextParser(): SitemapTextParser {
	const urls: string[] = [];
	const lastmods: (string | null)[] = [];
	const entries: ParsedSitemapEntry[] = [];
	const sitemaps: string[] = [];
	const stack: string[] = [];
	let root: string | null = null;
	let namespaced = false;
	let text = "";
	let entry: {
		loc: string;
		facts: ParsedSitemapEntry;
		alternates: Set<string> | null;
	} | null = null;
	let video: Set<string> | null = null;
	const namespaces = new Map<string, string>();
	const sets = new Map<string, Set<string>>();
	let alternatesKept = 0;
	let namespaceMissing = false;
	let wellFormed = true;
	let tooDeep = false;
	let opened: string | null = null;
	let listed = 0;
	let started = false;
	let lines: ReturnType<typeof textSitemapParser> | null = null;
	const feedLinks: string[] = [];
	const keep = (url: string, lastmod: string | null, facts: ParsedSitemapEntry): void => {
		listed += 1;
		if (urls.length >= SITEMAP_KEPT_URLS) return;
		urls.push(url);
		lastmods.push(lastmod);
		entries.push(facts);
	};
	const local = (name: string): string => {
		const colon = name.lastIndexOf(":");
		return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
	};
	const prefix = (name: string): string => {
		const colon = name.lastIndexOf(":");
		return colon === -1 ? "" : name.slice(0, colon).toLowerCase();
	};
	const parser: Parser = new Parser(
		{
			onopentag(name, attributes) {
				if (stack.length >= MARKUP_MAX_DEPTH) {
					tooDeep = true;
					parser.pause();
					return;
				}
				opened = name;
				const tag = local(name);
				if (root === null) {
					root = tag;
					namespaced = Object.entries(attributes).some(
						([attribute, value]) =>
							(attribute === "xmlns" || attribute.startsWith("xmlns:")) &&
							SITEMAP_NAMESPACES.has(value.trim())
					);
				}
				for (const [attribute, value] of Object.entries(attributes))
					if (attribute.startsWith("xmlns"))
						namespaces.set(own(attribute.slice(6)), own(value.trim()));
				const parent = stack[stack.length - 1];
				stack.push(tag);
				text = "";
				if (root === "feed" && tag === "link" && parent === "entry") {
					const rel = (attributes.rel ?? "alternate").trim().toLowerCase();
					const href = (attributes.href ?? "").trim();
					if (rel === "alternate" && href !== "" && feedLinks.length < SITEMAP_KEPT_URLS)
						feedLinks.push(own(href));
				}
				if (tag === "url") {
					entry = {
						loc: "",
						facts: {
							lastmod: null,
							deprecated: false,
							images: 0,
							videosIncomplete: 0,
							newsDates: []
						},
						alternates: alternatesKept < SITEMAP_KEPT_ALTERNATES ? new Set() : null
					};
				}
				if (entry === null) return;
				const space = prefix(name);
				if (stack.length === 3 && DEPRECATED_TAGS.has(tag)) entry.facts.deprecated = true;
				if (space === "image" && tag === "image") entry.facts.images += 1;
				if (space === "image" && DEPRECATED_IMAGE_TAGS.has(tag)) entry.facts.deprecated = true;
				if (space === "video" && tag === "video") video = new Set();
				else if (video !== null && space === "video") video.add(tag);
				const hreflang = attributes.hreflang ?? "";
				if (tag !== "link" || parent !== "url" || hreflang.trim() === "") return;
				if (!(attributes.rel ?? "").toLowerCase().split(/\s+/).includes("alternate")) return;
				const colon = name.indexOf(":");
				if (namespaces.get(colon === -1 ? "" : name.slice(0, colon)) !== XHTML_NS)
					namespaceMissing = true;
				const href = (attributes.href ?? "").trim();
				if (href !== "" && entry.alternates !== null && entry.alternates.size < MAX_ALTERNATES) {
					entry.alternates.add(own(href));
					alternatesKept += 1;
				}
			},
			ontext(chunk) {
				if (chunk.trim() !== "") opened = null;
				if (text.length < MAX_TEXT_CHARS) text += chunk.slice(0, MAX_TEXT_CHARS - text.length);
			},
			onclosetag(name, implied) {
				if (implied && opened !== name) wellFormed = false;
				opened = null;
				const tag = local(name);
				const parent = stack[stack.length - 2];
				const value = text.trim();
				if (tag === "loc" && value !== "") {
					if (parent === "sitemap" && sitemaps.length < SITEMAP_KEPT_URLS)
						sitemaps.push(own(value));
					else if (parent === "url" && entry !== null) entry.loc = own(value);
				} else if (root === "rss" && tag === "link" && parent === "item" && value !== "") {
					if (feedLinks.length < SITEMAP_KEPT_URLS) feedLinks.push(own(value));
				} else if (tag === "lastmod" && parent === "url" && entry !== null) {
					entry.facts.lastmod = own(value);
				} else if (tag === "publication_date" && entry !== null) {
					if (entry.facts.newsDates.length < MAX_NEWS_DATES) entry.facts.newsDates.push(own(value));
				} else if (
					tag === "video" &&
					prefix(name) === "video" &&
					entry !== null &&
					video !== null
				) {
					const seen = video;
					const complete =
						VIDEO_REQUIRED.every((required) => seen.has(required)) &&
						(seen.has("content_loc") || seen.has("player_loc"));
					if (!complete) entry.facts.videosIncomplete += 1;
					video = null;
				} else if (tag === "url" && entry !== null) {
					const kept = entry.loc !== "" && urls.length < SITEMAP_KEPT_URLS;
					if (entry.loc !== "")
						keep(
							entry.loc,
							/^(\d{4}-\d{2}-\d{2})/.exec(entry.facts.lastmod ?? "")?.[1] ?? null,
							entry.facts
						);
					const { alternates } = entry;
					if (alternates !== null && kept && alternates.size > 0) sets.set(entry.loc, alternates);
					else if (alternates !== null) alternatesKept -= alternates.size;
					entry = null;
				}
				text = "";
				stack.pop();
			}
		},
		{ xmlMode: true, decodeEntities: true, recognizeCDATA: true }
	);
	return {
		write(piece) {
			if (tooDeep) return false;
			if (!started) {
				const lead = piece.replace(/^\s+/u, "");
				if (lead === "") return true;
				started = true;
				if (!lead.startsWith("<")) lines = textSitemapParser();
			}
			lines?.write(piece);
			parser.write(piece);
			return !tooDeep;
		},
		end(cut = false) {
			const listedLines = lines?.end(cut) ?? null;
			if (listedLines !== null) {
				return {
					urls: listedLines.urls,
					lastmods: listedLines.urls.map(() => null),
					entries: listedLines.urls.map(() => bareEntry()),
					listed: listedLines.listed,
					sitemaps: [],
					root: "text",
					namespaced: true,
					wellFormed: true
				};
			}
			if (tooDeep) wellFormed = false;
			else if (!cut) parser.end();
			for (const link of feedLinks) keep(link, null, bareEntry());
			const hreflang = hreflangFacts(sets, namespaceMissing);
			return {
				urls,
				lastmods,
				entries,
				listed,
				sitemaps,
				root,
				namespaced: namespaced || feedLinks.length > 0 || root === "rss" || root === "feed",
				wellFormed,
				...(hreflang === undefined ? {} : { hreflang })
			};
		}
	};
}

/**
 * Parses one sitemap held whole ({@link sitemapTextParser}; the crawl reads a sitemap as it arrives,
 * {@link readSitemapStream}).
 *
 * @param xml - The file's text.
 * @returns The page URLs with their last-modified days and extra facts, the nested sitemaps, the
 *   root element, and the hreflang sets.
 */
export function parseSitemap(xml: string): ParsedSitemap {
	const parser = sitemapTextParser();
	parser.write(xml);
	return parser.end();
}

/** One sitemap file read as its bytes arrived. */
export interface SitemapStreamResult {
	/** The parsed file. */
	parsed: ParsedSitemap;
	/** Whether the file held nothing but white space. */
	blank: boolean;
	/** The unpacked bytes read, at most the cap: what the file cost, a gzip counted as it unpacks. */
	bytes: number;
	/**
	 * Whether the read stopped at the cap before the file's end (its unpacked text passed `maxBytes`).
	 * Such a file ends mid-tag; it is not therefore malformed.
	 */
	cut: boolean;
}

/** A sitemap read fed its bytes as they arrive. */
export interface SitemapStreamReader {
	/**
	 * Takes the next bytes of the body.
	 *
	 * @returns Whether the read takes more: false once it holds all it will read.
	 */
	write(bytes: Uint8Array): Promise<boolean>;
	/**
	 * Ends the read.
	 *
	 * @param truncated - Whether the transport cut the body at the cap.
	 */
	end(truncated: boolean): Promise<SitemapStreamResult>;
}

/**
 * The decoder of a body's text: the charset its `Content-Type` names when the runtime knows it, else
 * UTF-8.
 *
 * @param contentType - The header, if any.
 * @returns The decoder.
 */
function textDecoderOf(contentType: string | null): TextDecoder {
	const charset = /charset=([^;\s]+)/i.exec(contentType ?? "")?.[1]?.replace(/["']/g, "");
	try {
		return new TextDecoder(charset ?? "utf-8");
	} catch {
		return new TextDecoder("utf-8");
	}
}

/**
 * READS ONE SITEMAP AS ITS BYTES ARRIVE: gzip unpacked on the way when the bytes are gzip, the text
 * decoded and parsed a chunk at a time, so neither the body nor its text is ever held whole. At most
 * `maxBytes` of unpacked text are read; past it the read says it is done, so the transport can stop.
 * A gzip that cannot be unpacked keeps what it unpacked before the fault.
 *
 * @param contentType - The `Content-Type` header, if any.
 * @param maxBytes - The most unpacked bytes read.
 * @returns The reader.
 */
export function readSitemapStream(
	contentType: string | null,
	maxBytes: number
): SitemapStreamReader {
	const decoder = textDecoderOf(contentType);
	const parser = sitemapTextParser();
	let unpacked = 0;
	let blank = true;
	let cut = false;
	let done = false;
	let pending: Uint8Array | null = null;
	let sniffed = false;
	let gzip: {
		writer: WritableStreamDefaultWriter<BufferSource>;
		pump: Promise<void>;
	} | null = null;
	const feed = (bytes: Uint8Array): void => {
		if (done) return;
		const room = maxBytes - unpacked;
		const taken = bytes.byteLength > room ? bytes.subarray(0, Math.max(0, room)) : bytes;
		unpacked += taken.byteLength;
		const text = decoder.decode(taken, { stream: true }).replaceAll("\u0000", "");
		if (blank && text.trim() !== "") blank = false;
		const more = parser.write(text);
		if (bytes.byteLength > room) cut = true;
		if (!more || cut) done = true;
	};
	const unpack = (): typeof gzip => {
		const stream = new DecompressionStream("gzip");
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();
		const pump = (async () => {
			try {
				for (;;) {
					const { done: ended, value } = await reader.read();
					if (ended) return;
					feed(value);
					if (done) {
						await reader.cancel().catch(() => undefined);
						return;
					}
				}
			} catch {
				done = true;
			}
		})();
		return { writer, pump };
	};
	const route = async (bytes: Uint8Array): Promise<void> => {
		if (gzip === null) feed(bytes);
		else await gzip.writer.write(new Uint8Array(bytes)).catch(() => undefined);
	};
	return {
		async write(bytes) {
			if (done) return false;
			let chunk = bytes;
			if (!sniffed) {
				if (pending !== null) {
					chunk = new Uint8Array(pending.byteLength + bytes.byteLength);
					chunk.set(pending);
					chunk.set(bytes, pending.byteLength);
					pending = null;
				}
				if (chunk.byteLength < 2) {
					pending = chunk;
					return true;
				}
				sniffed = true;
				if (chunk[0] === 0x1f && chunk[1] === 0x8b) gzip = unpack();
			}
			await route(chunk);
			return !done;
		},
		async end(truncated) {
			if (pending !== null) feed(pending);
			if (gzip !== null) {
				await gzip.writer.close().catch(() => undefined);
				await gzip.pump;
			}
			if (!done) {
				const rest = decoder.decode().replaceAll("\u0000", "");
				if (blank && rest.trim() !== "") blank = false;
				parser.write(rest);
			}
			if (truncated) cut = true;
			return { parsed: parser.end(cut), blank, cut, bytes: unpacked };
		}
	};
}
