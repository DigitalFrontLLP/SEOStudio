/**
 * THE NESTING BOUND EVERY PARSER OF MARKUP FROM OUTSIDE READS BEHIND: a crawled page or sitemap, a page
 * the content writer reads, a WordPress post's stored content. The HTML and XML parsers used on it
 * (parse5, htmlparser2) spend time on each tag in proportion to how many elements are open, so a
 * document nested tens of thousands deep (`<div>` repeated, which a hostile site serves in a few hundred
 * kilobytes) costs time in the square of its size and holds the process for minutes. One linear pass
 * finds where the open elements first pass {@link MARKUP_MAX_DEPTH} and the document is cut there;
 * every real page (a few dozen deep; Chrome's own parser stops nesting at 512) comes back unchanged.
 *
 * THE COUNT NEVER FALLS BELOW EITHER PARSER'S, whatever the markup: a start tag is counted unless both
 * parsers are known to leave it closed, and an end tag closes elements only where both parsers close at
 * least as many. Where the rules differ (foreign content, integration points, foster parenting in a
 * table, end tags the parser ignores at a scope boundary, comments, a self-closing slash on an HTML
 * element) the pass counts more, never less: at worst a page with many markup errors is read only to
 * the bound. A run of elements a parser never nests directly (a new `<li>` closes the open one) only
 * nests through elements counted here, so the parsers hold at most twice the bound. Pure.
 *
 * THE SAME PASS BOUNDS THE ELEMENTS AN HTML PARSER RE-CREATES ({@link FormattingCount}). A formatting
 * element (`<b>`, `<font>`, ...) closed by the end of the block around it stays on parse5's list of
 * active formatting elements, and parse5 opens a copy of every such element again before the next
 * text or inline tag. A page of shallow `<div><b x=1>...<b x=30>t</div>` blocks keeps every element on
 * the list and has each block copy all of them: the tree grows in the square of the page, and a few
 * hundred kilobytes exhaust a gigabyte of memory without ever nesting deep. The pass keeps the list as
 * the parser would, counts every copy the parser may make, and cuts the document where the copies pass
 * {@link MARKUP_MAX_RECREATED} or the list passes {@link MARKUP_MAX_FORMATTING}. The count
 * errs towards more copies wherever it follows the parser (a real page, whose formatting elements close
 * where they open, makes next to none); for markup it does not follow (a table part outside any table
 * the pass knows of, a paragraph reopened inside a button) the parse's own work bound
 * (`./markup-parse` `parseWithinBudget`) still holds.
 *
 * THE SAME PASS BOUNDS THE ATTRIBUTES ON ONE TAG ({@link MARKUP_MAX_ATTRIBUTES}). parse5 checks each new
 * attribute's name against every name already on its tag, so one tag carrying tens of thousands of
 * distinct attributes costs time in the square of their count before any element exists, and a page
 * of such tags holds the process for minutes. Every tag the pass reads (start or end) has its
 * attributes counted the way the tokenizer reads them, a quoted value running to its own quote (a `>`
 * inside it hides nothing), and the document is cut at the first tag past the bound, or where the name
 * checks of the tags read so far pass {@link MARKUP_MAX_ATTRIBUTE_WORK}. The count never moves where the
 * pass reads next: it still goes on after a tag's first `>`, so what any parser reads as a tag is read
 * here too, and a count that runs through text no parser reads as a tag (a comment, a quote never
 * closed) only counts more. Its reading is bounded in total, so the pass stays linear. A real tag
 * carries a few dozen attributes at most.
 */

/** The most elements open at once that a document keeps; past it, the rest is not read. */
export const MARKUP_MAX_DEPTH = 512;

/**
 * The most formatting elements parse5's list may hold at once that a document keeps: a real page holds
 * a handful; past it, the rest is not read.
 */
export const MARKUP_MAX_FORMATTING = 256;

/**
 * The most formatting elements parse5 may re-create (copies of elements a block closed) that a document
 * keeps; past it, the rest is not read. Real pages re-create next to none (an old page that leaves a
 * `<font>` open in each block, a few per block); the bound keeps a crafted one to that many extra nodes.
 */
export const MARKUP_MAX_RECREATED = 100_000;

/** The most attributes one tag of an HTML document may carry that the document keeps; past it, the rest is not read. */
export const MARKUP_MAX_ATTRIBUTES = 1_000;

/**
 * The most name checks parse5 may make on the attributes of an HTML document's tags (a tag of `n`
 * attributes makes `n(n-1)/2`) that the document keeps; past it, the rest is not read. Real pages make
 * under 200,000; the bound keeps a page of tags just under {@link MARKUP_MAX_ATTRIBUTES} to a few
 * milliseconds of checks.
 */
export const MARKUP_MAX_ATTRIBUTE_WORK = 5_000_000;

/** Elements with no content in HTML that both parsers close at once. */
const VOID = new Set([
	"area",
	"base",
	"basefont",
	"br",
	"col",
	"embed",
	"frame",
	"hr",
	"image",
	"img",
	"input",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr"
]);

/**
 * HTML elements both parsers close when another of their kind starts on top of them (or, a form, ignore
 * while one is open), so they never nest directly in themselves.
 */
const NO_NEST = new Set([
	"a",
	"button",
	"dd",
	"dt",
	"form",
	"li",
	"optgroup",
	"option",
	"p",
	"tbody",
	"td",
	"th",
	"tr"
]);

/**
 * HTML elements whose content both parsers read as text up to their own end tag. An element only one of
 * them reads that way (a `<noscript>`, an `<iframe>`) is read for tags here, which only counts more.
 */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp"]);

/**
 * Raw-text elements parse5 ignores inside a `<select>`: their start does not switch its tokenizer, so
 * what follows is read for tags (and a `</select>` inside ends the select).
 */
const RAW_TEXT_IGNORED_IN_SELECT = new Set(["style", "title", "xmp"]);

/** The roots of foreign content: their children are SVG or MathML, not HTML. */
const FOREIGN_ROOTS = new Set(["svg", "math"]);

/** Foreign elements whose children are HTML again. */
const INTEGRATION_POINTS = new Set([
	"annotation-xml",
	"desc",
	"foreignobject",
	"mi",
	"mn",
	"mo",
	"ms",
	"mtext",
	"title"
]);

/** HTML start tags that end foreign content: the parser closes the foreign elements first. */
const BREAKOUT = new Set([
	"b",
	"big",
	"blockquote",
	"body",
	"br",
	"center",
	"code",
	"dd",
	"div",
	"dl",
	"dt",
	"em",
	"embed",
	"font",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"hr",
	"i",
	"img",
	"li",
	"listing",
	"menu",
	"meta",
	"nobr",
	"ol",
	"p",
	"pre",
	"ruby",
	"s",
	"small",
	"span",
	"strike",
	"strong",
	"sub",
	"sup",
	"table",
	"tt",
	"u",
	"ul",
	"var"
]);

/**
 * End tags the parser handles as a block: when the element is open inside the current scope, every
 * element opened after it is closed with it.
 */
const BLOCK_END = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"center",
	"details",
	"dialog",
	"dir",
	"div",
	"dl",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"header",
	"hgroup",
	"listing",
	"main",
	"menu",
	"nav",
	"ol",
	"pre",
	"search",
	"section",
	"summary",
	"ul"
]);

/** Elements a block end tag never closes past: the edges of a scope. */
const SCOPE_EDGES = new Set([
	"applet",
	"caption",
	"html",
	"marquee",
	"object",
	"table",
	"template",
	...FOREIGN_ROOTS,
	...INTEGRATION_POINTS
]);

/**
 * Phrasing elements no parser treats as special: an end tag of an element below them closes them with
 * it, in both parsers.
 */
const PHRASING = new Set([
	"abbr",
	"b",
	"bdi",
	"bdo",
	"big",
	"cite",
	"code",
	"data",
	"del",
	"dfn",
	"em",
	"font",
	"i",
	"ins",
	"kbd",
	"label",
	"mark",
	"q",
	"s",
	"samp",
	"small",
	"span",
	"strike",
	"strong",
	"sub",
	"sup",
	"time",
	"tt",
	"u",
	"var"
]);

/** How far down the open elements an end tag looks for its element; past it, the tag closes nothing. */
const END_TAG_REACH = 32;

/** The HTML formatting elements: the ones parse5 keeps on its list of active formatting elements. */
const FORMATTING = new Set([
	"a",
	"b",
	"big",
	"code",
	"em",
	"font",
	"i",
	"nobr",
	"s",
	"small",
	"strike",
	"strong",
	"tt",
	"u"
]);

/** Elements that put a marker on the formatting list: copies never reach past it, and their end clears back to it. */
const MARKERS = new Set(["applet", "caption", "marquee", "object", "template", "td", "th"]);

/** The table parts: inside a table they close an open cell (or caption) first, and nothing is copied at them. */
const TABLE_PARTS = new Set([
	"caption",
	"col",
	"colgroup",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr"
]);

/** End tags that close an open table cell (or caption) and what the table holds outside its cells. */
const TABLE_ENDS = new Set(["table", "tbody", "tfoot", "thead", "tr"]);

/** Start tags that close an open paragraph first (the elements parse5's "close a p element" serves). */
const PARAGRAPH_CLOSERS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"center",
	"dd",
	"details",
	"dialog",
	"dir",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hgroup",
	"hr",
	"li",
	"listing",
	"main",
	"menu",
	"nav",
	"ol",
	"p",
	"plaintext",
	"pre",
	"search",
	"section",
	"summary",
	"ul",
	"xmp"
]);

/** Start tags at which parse5 copies nothing: blocks, table parts, and what belongs in the head. */
const NO_COPY_STARTS = new Set([
	...[...PARAGRAPH_CLOSERS].filter((name) => name !== "xmp"),
	...TABLE_PARTS,
	"base",
	"basefont",
	"bgsound",
	"body",
	"frame",
	"frameset",
	"head",
	"html",
	"link",
	"meta",
	"noframes",
	"script",
	"style",
	"table",
	"template",
	"textarea",
	"title"
]);

/** Start tags with which parse5 may close open elements in ways the pass does not follow. */
const OTHER_CLOSING_STARTS = new Set([
	"body",
	"button",
	"frame",
	"frameset",
	"head",
	"html",
	"nobr",
	"select"
]);

/** Start tags that close an open `<select>` first. */
const SELECT_CLOSING_STARTS = new Set(["input", "keygen", "textarea"]);

/** The elements whose end parse5 implies (no end tag needed) that the pass follows: tag name to kind. */
const IMPLIED: ReadonlyMap<string, string> = new Map([
	["p", "p"],
	["li", "li"],
	["dd", "dd"],
	["dt", "dd"]
]);

/** One entry of the formatting list: its element's name and attributes, and where it stops being open. */
interface FormattingEntry {
	name: string;
	/** The start tag's attribute text: three entries alike in name and attributes are all parse5 keeps. */
	attributes: string;
	/** The open elements' length at or below which the element is closed. */
	closesAt: number;
	/** When it was opened (or copied), on the list's own clock: an implied end closes what came after. */
	since: number;
}

/**
 * The entries after one marker (the list's start, for the first): where they start in the list, the
 * element that set the marker, and the elements with implied ends open inside it, by kind, each with
 * the clock at its start.
 */
interface FormattingFrame {
	name: string;
	start: number;
	implied: Map<string, number>;
}

/** What may be closed: entries closing at or above a length, and entries opened after a time. */
interface Closed {
	from: number;
	since: number;
}

/** Nothing closed. */
const NONE_CLOSED: Closed = { from: Number.POSITIVE_INFINITY, since: Number.POSITIVE_INFINITY };

/**
 * PARSE5'S LIST OF ACTIVE FORMATTING ELEMENTS, kept along the pass, and a count of the copies parse5
 * may make of it. An entry is taken as possibly closed after any event that may close it (an end tag
 * that pops past it, the implied end of the paragraph or list item it was opened in, a start tag that
 * can close elements, an end tag the pass cannot place), and every possibly closed entry is charged as
 * copied at the next point parse5 re-creates the list (text, or a start tag it copies at). Markers (a
 * table cell, an `<object>`) are kept as parse5 keeps them: a copy never reaches past the last one, and
 * a closed cell's elements are dropped with it; one is cleared only by the end of the element on top.
 * Whatever may close while a marker is set is remembered for the entries before it, and charged once
 * the marker is cleared.
 */
class FormattingCount {
	private readonly entries: FormattingEntry[] = [];
	private readonly frames: FormattingFrame[] = [{ name: "", start: 0, implied: new Map() }];
	/** What may be closed among the entries after the last marker. */
	private closed: Closed = NONE_CLOSED;
	/** The same for the entries before it, all frames together. */
	private outerClosed: Closed = NONE_CLOSED;
	private clock = 0;
	/** The copies charged so far. */
	recreated = 0;

	/** @returns The entries on the list. */
	get size(): number {
		return this.entries.length;
	}

	/** @returns Whether the last marker is a table cell's or a caption's. */
	get inCell(): boolean {
		return CELLS_AND_CAPTION.has(this.top().name);
	}

	/**
	 * The frame after the last marker.
	 *
	 * @returns The frame.
	 */
	private top(): FormattingFrame {
		const frame = this.frames.at(-1);
		if (frame === undefined) throw new Error("The formatting list lost its first frame");
		return frame;
	}

	/**
	 * Takes in what may now be closed.
	 *
	 * @param closed - It.
	 */
	private close(closed: Closed): void {
		this.closed = {
			from: Math.min(this.closed.from, closed.from),
			since: Math.min(this.closed.since, closed.since)
		};
		this.outerClosed = {
			from: Math.min(this.outerClosed.from, closed.from),
			since: Math.min(this.outerClosed.since, closed.since)
		};
	}

	/** After an event the pass cannot place: every entry may be closed. */
	closeAll(): void {
		this.close({ from: Number.NEGATIVE_INFINITY, since: Number.POSITIVE_INFINITY });
	}

	/**
	 * After the open elements fell to `length`: entries that close at or above it are closed.
	 *
	 * @param length - The open elements' length after the event.
	 */
	closeTo(length: number): void {
		this.close({ from: length, since: Number.POSITIVE_INFINITY });
	}

	/**
	 * An element with an implied end starts in the current frame (a start of its kind ends the one open).
	 *
	 * @param kind - Its kind.
	 */
	openImplied(kind: string): void {
		this.closeImplied(kind);
		this.top().implied.set(kind, this.clock);
	}

	/**
	 * The open element of a kind with an implied end ends: what was opened inside it is closed.
	 *
	 * @param kind - Its kind.
	 */
	closeImplied(kind: string): void {
		const implied = this.top().implied;
		const since = implied.get(kind);
		if (since === undefined) return;
		implied.delete(kind);
		this.close({ from: Number.POSITIVE_INFINITY, since });
	}

	/**
	 * A point where parse5 re-creates the list: every entry after the last marker that may be closed is
	 * charged as copied, and is open again, as a copy above the current open elements.
	 *
	 * @param open - The open elements' length.
	 */
	recreate(open: number): void {
		const { from, since } = this.closed;
		if (from === Number.POSITIVE_INFINITY && since === Number.POSITIVE_INFINITY) return;
		for (let index = this.top().start; index < this.entries.length; index += 1) {
			const entry = this.entries[index];
			if (entry !== undefined && (entry.closesAt >= from || entry.since > since)) {
				this.recreated += 1;
				this.clock += 1;
				entry.closesAt = open - 1;
				entry.since = this.clock;
			}
		}
		this.closed = NONE_CLOSED;
		if (this.frames.length === 1) this.outerClosed = NONE_CLOSED;
	}

	/**
	 * A formatting element starts and joins the list (a link first drops the link already on it, and a
	 * fourth entry alike drops the earliest, as parse5 does).
	 *
	 * @param name - Its name.
	 * @param attributes - Its start tag's attribute text.
	 * @param closesAt - The open elements' length at or below which it is closed.
	 */
	open(name: string, attributes: string, closesAt: number): void {
		const start = this.top().start;
		if (name === "a") {
			const link = this.lastNamed("a", start);
			if (link !== -1) {
				this.closeAll();
				this.entries.splice(link, 1);
			}
		}
		let alike = 0;
		let earliest = -1;
		for (let index = this.entries.length - 1; index >= start; index -= 1) {
			const entry = this.entries[index];
			if (entry?.name === name && entry.attributes === attributes) {
				alike += 1;
				earliest = index;
			}
		}
		if (alike >= 3) this.entries.splice(earliest, 1);
		this.clock += 1;
		this.entries.push({ name, attributes, closesAt, since: this.clock });
	}

	/**
	 * A formatting element's own end tag. Placed (the pass closed it, `closedTo` being the open elements'
	 * length after): what was opened inside it is closed. Not placed: anything may be. parse5 drops the
	 * element's latest entry after the last marker either way.
	 *
	 * @param name - Its name.
	 * @param closedTo - The open elements' length after the pass closed it, or null when the pass
	 * could not place the end tag.
	 */
	end(name: string, closedTo: number | null): void {
		const index = this.lastNamed(name, this.top().start);
		const entry = this.entries[index];
		if (closedTo !== null) this.closeTo(closedTo);
		else if (name === "a" && entry !== undefined) this.closeTo(entry.closesAt + 1);
		else this.closeAll();
		if (index !== -1) this.entries.splice(index, 1);
	}

	/**
	 * A marker element starts.
	 *
	 * @param name - Its name.
	 */
	mark(name: string): void {
		this.outerClosed = {
			from: Math.min(this.outerClosed.from, this.closed.from),
			since: Math.min(this.outerClosed.since, this.closed.since)
		};
		this.closed = NONE_CLOSED;
		this.frames.push({ name, start: this.entries.length, implied: new Map() });
	}

	/**
	 * A marker element ends: when it set the last marker, the entries after it go.
	 *
	 * @param names - The names whose marker may be cleared.
	 */
	unmark(names: ReadonlySet<string> | string): void {
		if (this.frames.length === 1) return;
		const top = this.top();
		if (typeof names === "string" ? top.name !== names : !names.has(top.name)) return;
		this.entries.length = top.start;
		this.frames.pop();
		this.closed = this.outerClosed;
	}

	/**
	 * The index of the latest entry of a name at or after `start`.
	 *
	 * @param name - The name.
	 * @param start - Where to stop looking.
	 * @returns The index, or -1.
	 */
	private lastNamed(name: string, start: number): number {
		for (let index = this.entries.length - 1; index >= start; index -= 1) {
			if (this.entries[index]?.name === name) return index;
		}
		return -1;
	}
}

/** The cells a table part closes. */
const CELLS = new Set(["td", "th"]);

/** The cells and the caption a table's end closes. */
const CELLS_AND_CAPTION = new Set(["td", "th", "caption"]);

/**
 * Where the text after a tag starts: past the first `>` before `limit`, or `limit` when there is none.
 *
 * @param markup - The document.
 * @param from - Where to look from.
 * @param limit - The next `<`.
 * @returns The index.
 */
function afterTag(markup: string, from: number, limit: number): number {
	for (let index = from; index < limit; index += 1) {
		if (markup.charCodeAt(index) === 62) return index + 1;
	}
	return limit;
}

/**
 * What an HTML start tag (outside foreign content) closes on the formatting list before it is inserted.
 *
 * @param list - The list.
 * @param name - The tag's name.
 * @param inTable - Whether a table is open.
 * @param inSelect - Whether a select is open.
 */
function startTag(list: FormattingCount, name: string, inTable: boolean, inSelect: boolean): void {
	if (TABLE_PARTS.has(name)) {
		if (!inTable) return;
		list.unmark(CELLS);
		if (name !== "caption") list.unmark("caption");
		list.closeAll();
		return;
	}
	if (name === "table" && inTable && !list.inCell) {
		list.closeAll();
		return;
	}
	if (PARAGRAPH_CLOSERS.has(name) || name === "table") list.closeImplied("p");
	const kind = IMPLIED.get(name);
	if (kind !== undefined) list.openImplied(kind);
	if (OTHER_CLOSING_STARTS.has(name) || (inSelect && SELECT_CLOSING_STARTS.has(name))) {
		list.closeAll();
	}
}

/**
 * What an HTML end tag closes on the formatting list.
 *
 * @param list - The list.
 * @param name - The tag's name.
 * @param closedTo - The open elements' length after the pass closed the tag's element, or null when
 * the pass could not place the tag.
 * @param inTable - Whether a table was open before the tag.
 */
function endTag(
	list: FormattingCount,
	name: string,
	closedTo: number | null,
	inTable: boolean
): void {
	if (FORMATTING.has(name)) {
		list.end(name, closedTo);
		return;
	}
	const kind = IMPLIED.get(name);
	if (kind !== undefined) {
		list.closeImplied(kind);
		return;
	}
	if (CELLS_AND_CAPTION.has(name)) {
		list.unmark(name === "caption" ? "caption" : CELLS);
		return;
	}
	if (name === "option" || name === "optgroup") return;
	if (TABLE_ENDS.has(name)) {
		if (!inTable) return;
		list.unmark(name === "table" ? CELLS_AND_CAPTION : CELLS);
		list.closeAll();
		return;
	}
	if (MARKERS.has(name)) list.unmark(name);
	if (closedTo === null) list.closeAll();
	else list.closeTo(closedTo);
}

/** One open element: its name, and whether its children are foreign (SVG or MathML) content. */
interface OpenElement {
	name: string;
	foreign: boolean;
}

/**
 * Whether a character code can start a tag name.
 *
 * @param code - The character code.
 * @returns Whether it is an ASCII letter.
 */
function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Where a tag name that starts at `start` ends.
 *
 * @param markup - The document.
 * @param start - Where the name starts.
 * @returns The index after its last character.
 */
function nameEnd(markup: string, start: number): number {
	let end = start;
	while (end < markup.length) {
		const code = markup.charCodeAt(end);
		if (
			code === 62 ||
			code === 47 ||
			code === 32 ||
			code === 9 ||
			code === 10 ||
			code === 13 ||
			code === 12
		)
			break;
		end += 1;
	}
	return end;
}

/**
 * Whether a character code is white space inside a tag (a carriage return is one, as the parser's input
 * stream turns it into a line feed).
 *
 * @param code - The character code.
 * @returns Whether it is.
 */
function isTagSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/** How many attributes an HTML tag carries as parse5's tokenizer reads them, and how far the read went. */
interface TagAttributes {
	/** The attributes counted, past `limit` when the read stopped at it. */
	count: number;
	/** The index the read stopped at: the tag's `>`, the end of the document, or the attribute past the limit. */
	stop: number;
}

/**
 * Counts an HTML tag's attributes from just after its name the way parse5's tokenizer reads them: a
 * value in quotes runs to its own closing quote (a `>` inside it does not end the tag), an unquoted
 * value to white space or `>`, and a quote, `=` or `<` where a name is read is part of the name.
 *
 * @param markup - The document.
 * @param from - The index just after the tag's name.
 * @param limit - The count past which the read stops.
 * @returns The count and where the read stopped.
 */
function tagAttributes(markup: string, from: number, limit: number): TagAttributes {
	let count = 0;
	let index = from;
	/** Before a name (0), in a name (1), after a name (2), before a value (3), in an unquoted value (4). */
	let state = 0;
	while (index < markup.length) {
		const code = markup.charCodeAt(index);
		if (code === 62 && state !== 3) return { count, stop: index };
		if (state === 0) {
			if (!isTagSpace(code) && code !== 47) {
				count += 1;
				if (count > limit) return { count, stop: index };
				state = 1;
			}
		} else if (state === 1) {
			if (isTagSpace(code) || code === 47) state = code === 47 ? 0 : 2;
			else if (code === 61) state = 3;
		} else if (state === 2) {
			if (code === 47) state = 0;
			else if (code === 61) state = 3;
			else if (!isTagSpace(code)) {
				count += 1;
				if (count > limit) return { count, stop: index };
				state = 1;
			}
		} else if (state === 3) {
			if (code === 62) return { count, stop: index };
			if (code === 34 || code === 39) {
				const shut = markup.indexOf(code === 34 ? '"' : "'", index + 1);
				if (shut === -1) return { count, stop: markup.length };
				index = shut;
				state = 0;
			} else if (!isTagSpace(code)) state = 4;
		} else if (isTagSpace(code)) state = 0;
		index += 1;
	}
	return { count, stop: markup.length };
}

/**
 * How many open elements an HTML end tag closes (0 when it closes none): the matching element and
 * every element opened after it, only when both parsers close at least those. An element of foreign
 * content closes only from the top.
 *
 * @param stack - The open elements.
 * @param name - The end tag's name.
 * @returns How many to close.
 */
function closedBy(stack: readonly OpenElement[], name: string): number {
	const lowest = Math.max(0, stack.length - END_TAG_REACH);
	for (let index = stack.length - 1; index >= lowest; index -= 1) {
		const entry = stack[index];
		if (entry === undefined) return 0;
		if (entry.name === name) return stack.length - index;
		if (entry.name === "select") return 0;
		const parent = stack[index - 1];
		if (parent?.foreign === true) return 0;
		const passable = BLOCK_END.has(name) ? !SCOPE_EDGES.has(entry.name) : PHRASING.has(entry.name);
		if (!passable) return 0;
	}
	return 0;
}

/**
 * A document cut where its open elements first pass the bound, or the document itself when it never
 * does. An XML document (`options.xml`) counts every element not closed by `/>`, and an end tag closes
 * only the element on top. An HTML document is also cut where parse5's copies of closed formatting
 * elements pass their bounds, and at a tag whose attributes pass theirs (see the file's notes).
 *
 * @param markup - An HTML or XML document.
 * @param options.xml - Whether it is XML.
 * @param options.maxDepth - The most elements open at once that the document keeps.
 * @param options.maxRecreated - The most formatting elements parse5 may re-create that an HTML
 * document keeps.
 * @param options.maxFormatting - The most formatting elements parse5's list may hold at once that an
 * HTML document keeps.
 * @param options.maxAttributes - The most attributes one tag of an HTML document may carry that the
 * document keeps.
 * @param options.maxAttributeWork - The most attribute name checks parse5 may make that an HTML
 * document keeps.
 * @returns The document, cut when it nests deeper, makes the parser copy more, or carries more
 * attributes.
 */
export function cutDeepMarkup(
	markup: string,
	options: {
		xml?: boolean;
		maxDepth?: number;
		maxRecreated?: number;
		maxFormatting?: number;
		maxAttributes?: number;
		maxAttributeWork?: number;
	} = {}
): string {
	const xml = options.xml === true;
	const maxDepth = options.maxDepth ?? MARKUP_MAX_DEPTH;
	const maxRecreated = options.maxRecreated ?? MARKUP_MAX_RECREATED;
	const maxFormatting = options.maxFormatting ?? MARKUP_MAX_FORMATTING;
	const maxAttributes = options.maxAttributes ?? MARKUP_MAX_ATTRIBUTES;
	const maxAttributeWork = options.maxAttributeWork ?? MARKUP_MAX_ATTRIBUTE_WORK;
	/** The attribute name checks parse5 makes on the tags read so far. */
	let attributeWork = 0;
	/** How much the attribute counts may read in all: past it the document is cut, so the pass stays linear. */
	let attributeReach = 2 * markup.length + 4_096;
	/**
	 * Counts an HTML tag's attributes and charges them to the bounds.
	 *
	 * @param from - The index just after the tag's name.
	 * @returns Whether the document keeps the tag.
	 */
	const attributesKept = (from: number): boolean => {
		const attributes = tagAttributes(markup, from, maxAttributes);
		attributeReach -= attributes.stop - from;
		attributeWork += (attributes.count * (attributes.count - 1)) / 2;
		return (
			attributes.count <= maxAttributes && attributeWork <= maxAttributeWork && attributeReach >= 0
		);
	};
	const stack: OpenElement[] = [];
	const formatting = xml ? null : new FormattingCount();
	/** How many tables are open, for the cells parse5 reads as cells (and marks) only inside one. */
	let tables = 0;
	/** How many selects are open, which a field's start closes. */
	let selects = 0;
	/** Where the text after the last tag starts. */
	let text = 0;
	let at = markup.indexOf("<");
	/**
	 * Closes the top `count` open elements.
	 *
	 * @param count - How many.
	 */
	const pop = (count: number): void => {
		for (let index = stack.length - count; index < stack.length; index += 1) {
			const name = stack[index]?.name;
			if (name === "table") tables -= 1;
			else if (name === "select") selects -= 1;
		}
		stack.length -= count;
	};
	/**
	 * Whether the text before `at` is white space a table holds outside its cells, at which parse5
	 * copies nothing.
	 *
	 * @param list - The formatting list.
	 * @returns Whether it is.
	 */
	const tableSpace = (list: FormattingCount): boolean => {
		if (tables === 0 || list.inCell || stack.at(-1)?.name !== "table") return false;
		for (let index = text; index < at; index += 1) {
			const code = markup.charCodeAt(index);
			if (code !== 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) return false;
		}
		return true;
	};
	while (at !== -1) {
		if (formatting !== null && at > text && !tableSpace(formatting)) {
			formatting.recreate(stack.length);
			if (formatting.recreated > maxRecreated) return markup.slice(0, text);
		}
		const next = markup.charCodeAt(at + 1);
		if (next === 47 && isLetter(markup.charCodeAt(at + 2))) {
			const end = nameEnd(markup, at + 2);
			if (!xml && !attributesKept(end)) return markup.slice(0, at);
			const name = markup.slice(at + 2, end).toLowerCase();
			const top = stack.at(-1);
			const closed = xml ? (top?.name === name ? 1 : 0) : closedBy(stack, name);
			const inTable = tables > 0;
			pop(closed);
			at = markup.indexOf("<", end);
			if (formatting !== null) {
				text = afterTag(markup, end, at === -1 ? markup.length : at);
				endTag(formatting, name, closed > 0 ? stack.length : null, inTable);
			}
			continue;
		}
		if (!isLetter(next)) {
			at = markup.indexOf("<", at + 1);
			continue;
		}
		const end = nameEnd(markup, at + 1);
		const name = markup.slice(at + 1, end).toLowerCase();
		if (!xml && !attributesKept(end)) return markup.slice(0, at);
		const close = markup.indexOf(">", end);
		if (close === -1) return markup;
		const selfClosed = markup.charCodeAt(close - 1) === 47;
		let foreign = !xml && stack.at(-1)?.foreign === true;
		if (foreign && BREAKOUT.has(name)) {
			for (let index = stack.length - 1; stack[index]?.foreign === true; index -= 1) {
				const entry = stack[index];
				if (entry !== undefined) entry.foreign = false;
			}
			foreign = false;
		}
		if (formatting !== null) {
			if (!foreign) startTag(formatting, name, tables > 0, selects > 0);
			if (foreign || !NO_COPY_STARTS.has(name)) {
				formatting.recreate(stack.length);
				if (formatting.recreated > maxRecreated) return markup.slice(0, at);
			}
			if (FORMATTING.has(name) && (!foreign || name === "font")) {
				const attributes = markup.slice(end, selfClosed ? close - 1 : close).trim();
				const pushed = !VOID.has(name) && !NO_NEST.has(name);
				formatting.open(name, attributes, pushed ? stack.length : stack.length - 1);
				if (formatting.size > maxFormatting) return markup.slice(0, at);
			}
			if (!foreign && MARKERS.has(name) && (tables > 0 || !CELLS_AND_CAPTION.has(name))) {
				formatting.mark(name);
			}
		}
		if (
			!xml &&
			!foreign &&
			RAW_TEXT.has(name) &&
			!(selects > 0 && RAW_TEXT_IGNORED_IN_SELECT.has(name))
		) {
			const pattern = new RegExp(`</${name}[\\s/>]`, "giu");
			pattern.lastIndex = close + 1;
			const found = pattern.exec(markup);
			if (found === null) return markup;
			if (!attributesKept(found.index + 2 + name.length)) return markup.slice(0, found.index);
			at = markup.indexOf("<", found.index + 2);
			text = afterTag(markup, found.index + 2, at === -1 ? markup.length : at);
			continue;
		}
		const opens = xml || foreign ? !selfClosed : !VOID.has(name) && !NO_NEST.has(name);
		if (opens) {
			if (stack.length >= maxDepth) return markup.slice(0, at);
			stack.push({
				name,
				foreign: !xml && (foreign ? !INTEGRATION_POINTS.has(name) : FOREIGN_ROOTS.has(name))
			});
			if (name === "table") tables += 1;
			else if (name === "select") selects += 1;
		}
		text = close + 1;
		at = markup.indexOf("<", close + 1);
	}
	return markup;
}
