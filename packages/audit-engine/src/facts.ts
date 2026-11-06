/**
 * THE CRAWL FACTS: what one reading of a page, a site's robots.txt, its sitemaps and its resources
 * leaves for the audit, as plain JSON shapes. The crawler writes them, the rules read them, and a host
 * may store them as they are (SeoStudio keeps them in its database's JSON columns).
 *
 * Types only: this file loads nothing at runtime.
 */

/**
 * How a page was read: `browser` - rendered by a headless browser as Google renders it, every field
 * known (every page since full rendering); `plain` - its raw HTML alone, when the render failed;
 * `rendered` - the retired text-only fallback (older snapshots: main text, status and headers only).
 */
export type SeoPageFetchModeValue = "plain" | "rendered" | "browser";

/** How the browser render of a page ended: settled, cut at its time limit, or failed. */
export type SeoPageRenderOutcomeValue = "ok" | "timeout" | "failed";

/** One request a page's render needed and could not complete, as the audit keeps it. */
export interface SeoPageRenderResourceFailure {
	/** The URL asked for. */
	url: string;
	/** What the page asked for. */
	type: "script" | "stylesheet" | "xhr" | "fetch" | "other";
	/** Why: robots.txt forbids the crawler, the server answered an error status, or nothing answered. */
	reason: "robots" | "status" | "network";
	/** The error status, when the server answered one. */
	status: number | null;
}

/** A field JavaScript changed: what the raw HTML said, and what the rendered page says (empty when absent). */
export interface SeoPageRenderChange {
	raw: string;
	rendered: string;
}

/**
 * WHAT THE BROWSER RENDER OF A PAGE FOUND, beside what its raw HTML said: the site audit judges the
 * rendered page and compares the two (links, metadata and text JavaScript adds or changes, script
 * errors, failed resources, timeouts). Values are cut short; lists keep a few examples and a count.
 */
export interface SeoPageRenderFacts {
	outcome: SeoPageRenderOutcomeValue;
	/** Why a render failed (`unavailable`, `busy`, `navigation`, `crashed`, `navigated`, `bot_wall`, ...), or null. */
	error: string | null;
	/** Where a script sent the browser when the render ended on another document (`navigated`); absent otherwise. */
	navigatedTo?: string;
	/** How long the render took, in ms. */
	renderMs: number;
	/** Main-text words of the raw HTML and of the rendered page (null when it was not rendered). */
	rawWords: number;
	renderedWords: number | null;
	/** Internal links of the raw HTML and of the rendered page. */
	rawInternalLinks: number;
	renderedInternalLinks: number | null;
	/** Internal pages the rendered page links to that the raw HTML does not. */
	jsOnlyLinks: { count: number; examples: string[] };
	/** The fields JavaScript added, changed or removed; a field left out is the same in both. */
	changed: {
		title?: SeoPageRenderChange;
		metaDescription?: SeoPageRenderChange;
		canonical?: SeoPageRenderChange;
		robots?: SeoPageRenderChange;
		/** The hreflang alternates, as `lang url` lines joined. */
		hreflang?: SeoPageRenderChange & { rawCount: number; renderedCount: number };
		/** The first H1 with text; absent on reads made before it was compared. */
		h1?: SeoPageRenderChange;
		/** The structured data types JavaScript added (absent from the raw HTML), in name order; absent when none. */
		schemaTypesAdded?: string[];
	};
	/** Uncaught script errors and console errors the page logged while it rendered. */
	consoleErrors: { count: number; examples: string[] };
	/**
	 * Scripts, stylesheets and data requests on the site that robots.txt keeps the crawler from, with
	 * how many of them are stylesheets and scripts (absent on reads made before they were counted).
	 */
	blockedResources: { count: number; examples: string[]; stylesheets?: number; scripts?: number };
	/** Scripts and stylesheets that failed to load: an error status, or no answer. */
	failedResources: { count: number; examples: SeoPageRenderResourceFailure[] };
	/**
	 * How the parser read the RAW HTML's head as served, beside the stored page's own
	 * ({@link SeoPageMarkupFacts.head}); absent on reads made before it was kept.
	 */
	rawHead?: SeoPageHeadFacts | null;
	/**
	 * The head elements search engines read (canonical, robots, hreflang, title, description) that the
	 * parser placed in `<body>` when it read the RAW HTML as served; absent on reads made before it was
	 * kept.
	 */
	rawOutsideHead?: ("canonical" | "robots" | "hreflang" | "title" | "description")[];
	/**
	 * What the in-page probe measured on the rendered page (layout, images, overlays, history, weight);
	 * absent on reads made before it ran, null when it could not run.
	 */
	dom?: SeoPageDomFacts | null;
	/** What the accessibility checks (axe-core) found; absent when they did not run on this read. */
	a11y?: SeoPageA11yFacts | null;
	/**
	 * The same page rendered as a desktop browser sees it (the desktop app's second render), for the
	 * mobile and desktop parity check; absent when there was no second render.
	 */
	desktop?: SeoPageDesktopView | null;
}

/** One image of a rendered page as the probe measured it. */
export interface SeoPageDomImage {
	/** The URL the browser chose for it (`currentSrc`, else `src`), absolute. */
	url: string;
	/** Its rendered box, in CSS pixels. */
	width: number;
	height: number;
	/** How far down the page its top edge sits, in CSS pixels; absent on reads made before it was kept. */
	top?: number;
}

/**
 * WHAT THE IN-PAGE PROBE MEASURED on a rendered page, on the phone's viewport, before any scroll:
 * layout widths, text sizes, tap targets, images, the largest paint, layout shifts, the DOM's size, what
 * covers the content, links built from other elements, the history entries the page added, infinite
 * scroll, and what the page transferred. Lists keep a few examples; values are cut short.
 */
export interface SeoPageDomFacts {
	/** The layout viewport, in CSS pixels. */
	viewport: { width: number; height: number };
	/** The document's scroll width, in CSS pixels: wider than the viewport means a horizontal scroll. */
	contentWidth: number;
	/** Elements that reach past the viewport's right edge, as short CSS paths. */
	overflowing: string[];
	/** Visible text characters, and how many of them are set under 12 CSS pixels. */
	text: { chars: number; smallChars: number };
	/** Visible tap targets, and how many are under 24 by 24 CSS pixels with no room around them. */
	tapTargets: { total: number; small: number; examples: string[] };
	/** The visible images, rendered size and URL. */
	images: SeoPageDomImage[];
	/** Images below the first screen that load at once (not lazy). */
	offscreenEager: { count: number; examples: string[] };
	/** The largest content element on the first screen, or null when none was found. */
	lcp: {
		kind: "image" | "text" | "video";
		selector: string;
		/** The image's URL, for an image or a video poster. */
		url: string | null;
		/** Whether the image is lazy-loaded (natively or by a script). */
		lazy: boolean;
		/** Its `fetchpriority` attribute, or null. */
		fetchPriority: string | null;
	} | null;
	/**
	 * The first screen's images that fade in (loaded at opacity 0, then shown by an opacity transition
	 * or animation): Chrome never takes one as the largest paint. Absent on renders made before it.
	 */
	fadedIn?: string[];
	/** Layout shifts while the page loaded: the summed score, how many, and the shifted elements. */
	layoutShift: { score: number; count: number; sources: string[] };
	/** Elements, the deepest nesting and the most children of one element. */
	dom: { elements: number; depth: number; width: number };
	/**
	 * The history entries the page added while it loaded, without any visitor action, and whether one
	 * of them repeats the entry before it (a trap for the Back button).
	 */
	history: { pushed: number; repeated: boolean };
	/** An element fixed over the first screen covering most of the content, or null. */
	overlay: { selector: string; coverage: number } | null;
	/** Elements other than links that act as links (a link role, or a URL in a data attribute). */
	fakeLinks: { count: number; examples: string[] };
	/**
	 * Whether scrolling to the bottom loaded more content, and whether the page also offers the next
	 * part at a URL of its own (a link to a next page, or the address changing); null when not tested.
	 */
	infiniteScroll: { grew: boolean; paginated: boolean } | null;
	/**
	 * What the page transferred while it loaded: the document, its scripts, styles and data (bytes as
	 * served), and the images and fonts it asked for (their size is the resource checks').
	 */
	transfer: { bytes: number; requests: number; images: string[]; fonts: string[] };
}

/** What the accessibility checks (axe-core) found on a rendered page. */
export interface SeoPageA11yFacts {
	/** Which rules ran: the search-relevant subset (the server) or all of them (the desktop app). */
	rules: "seo" | "all";
	/** Each rule the page fails, the elements that fail it and a few of them as CSS paths. */
	violations: { id: string; count: number; examples: string[] }[];
}

/** The page as a desktop browser rendered it, for the mobile and desktop parity check. */
export interface SeoPageDesktopView {
	outcome: SeoPageRenderOutcomeValue;
	title: string;
	metaRobots: string;
	canonical: string;
	/** Main-text words. */
	words: number;
	schemaTypes: string[];
}

/** Where a link sits on its page. */
export type SeoPageLinkPlacementValue = "body" | "nav" | "footer" | "image";

/** How serious an audit issue is. */
export type SeoPageIssueSeverityValue = "critical" | "warning" | "notice";

/** One hop of a redirect chain, as a snapshot stores it. */
export interface SeoPageRedirectHop {
	/** The URL that answered. */
	url: string;
	/** Its HTTP status. */
	status: number;
	/**
	 * The URL exactly as the previous hop's `Location` spelled it (resolved), when it differs from `url`:
	 * an `http:` target the crawler fetched over https. Absent on the first hop and when they agree.
	 */
	location?: string;
}

/** One heading of a page's outline, as a snapshot stores it. */
export interface SeoPageHeading {
	/** 1 to 6. */
	level: number;
	/** The heading's text, whitespace collapsed. */
	text: string;
}

/** One hreflang alternate, as a snapshot stores it. */
export interface SeoPageHreflang {
	/** The language-region code as written. */
	lang: string;
	/** The alternate's URL as written. */
	url: string;
}

/** One JSON-LD block as the audit keeps it: the raw text, or a marker when the page's budget ran out. */
export interface SeoPageJsonLdBlock {
	/** The block's text as the page served it, or null when it was left out for size. */
	text: string | null;
	/** The block's size in characters. */
	chars: number;
}

/** How an image is lazy-loaded: the native attribute, a JavaScript loader, or not at all. */
export type SeoPageLazyMethodValue = "native" | "javascript" | "none";

/** A text value read from the markup, and whether the HTML parser placed it inside `<head>`. */
export interface SeoPageMarkupText {
	/** The value as written, whitespace collapsed and cut short. */
	text: string;
	inHead: boolean;
}

/**
 * HOW THE HTML PARSER READ A PAGE'S HEAD. The parse follows the HTML standard: an element that is not
 * allowed in `<head>` (an `<img>`, a `<div>`, text, an `<iframe>` or `<img>` inside a `<noscript>` of
 * the raw HTML) ends the head there, and everything after it lands in `<body>`. Read from the page as
 * stored (the rendered DOM, serialized and parsed again: what a script put in the head that ends it)
 * and, for the raw-against-rendered comparison, from the raw HTML as served
 * ({@link SeoPageRenderFacts.rawHead}).
 */
export interface SeoPageHeadFacts {
	/** `<html>`, `<head>` and `<body>` start tags written in the source. */
	htmlTags: number;
	headTags: number;
	bodyTags: number;
	/** Whether an element or text came before the `<html>` tag. */
	contentBeforeHtml: boolean;
	/** Whether the head began before its own `<head>` tag (an element came first and opened it). */
	headNotFirst: boolean;
	/**
	 * The element (or `#text`) that ended `<head>` before its `</head>` or `<body>` tag, so the elements
	 * after it were moved into `<body>`; null when the head ended where the source ends it.
	 */
	breaker: { tag: string; line: number; inNoscript: boolean } | null;
}

/** A robots directive group: whom it addresses (`robots` for every crawler) and its tokens. */
export interface SeoPageRobotsGroup {
	/** `robots`, or the crawler named (`googlebot`, `bingbot`, ...), lowercased. */
	agent: string;
	/** Each directive, lowercased, `name:value` for the ones with a value (`max-snippet:0`). */
	tokens: string[];
}

/** A viewport meta tag, its content as written and the properties it sets (null when not set). */
export interface SeoPageViewport {
	content: string;
	width: string | null;
	initialScale: string | null;
	minimumScale: string | null;
	maximumScale: string | null;
	userScalable: string | null;
	inHead: boolean;
}

/** The kinds of link href the audit flags. */
export type SeoPageBadLinkKindValue =
	| "empty"
	| "whitespace"
	| "whitespace_query"
	| "malformed"
	| "javascript"
	| "onclick"
	| "localhost"
	| "file"
	| "protocol";

/**
 * The site builder or framework a page's markup shows it was made with (its generator tag, or the
 * file paths and hosts only that platform serves), for the fix hints of the platforms whose fix differs.
 */
export type SeoSitePlatformValue =
	| "squarespace"
	| "wix"
	| "shopify"
	| "wordpress"
	| "ghost"
	| "webflow"
	| "nextjs"
	| "discourse"
	| "framer"
	| "joomla"
	| "prestashop"
	| "nuxt";

/** One image as the markup states it. */
export interface SeoPageMarkupImage {
	/** The URL the image shows (src, a lazy-loader's attribute, or the first srcset entry), as written. */
	src: string;
	/** The alt text cut short, or null when the attribute is absent (`""` is decorative). */
	alt: string | null;
	/** The alt text's full length. */
	altLength: number;
	/** Whether it offers sizes: a srcset (its own, a lazy-loader's or a `<picture>` source's), and `sizes`. */
	srcset: boolean;
	sizes: boolean;
	/** The `loading` and `fetchpriority` attributes, lowercased, or null. */
	loading: string | null;
	fetchPriority: string | null;
	/** The `width` and `height` attributes as written, or null. */
	width: string | null;
	height: string | null;
}

/** One microdata or RDFa item of the page's schema.org markup, read into the shape of a JSON-LD item. */
export interface SeoPageMarkupItem {
	syntax: "microdata" | "rdfa";
	/** The item as JSON (`@type`, `@id` and its properties, nested items inline). */
	json: string;
}

/**
 * A price or a rating the page's structured data states (any syntax), and whether the page's visible
 * text shows it: an offer's prices (`price`, `lowPrice`), or a rating's value and counts.
 */
export interface SeoPageMarkedValues {
	/** The type holding the offers or the rating (`Product`, `LocalBusiness`, `AggregateRating`). */
	type: string;
	property: "price" | "rating";
	/** The values stated, as numbers with two decimals. */
	values: string[];
	/** Whether the visible page shows any of them. */
	visible: boolean;
}

/**
 * WHAT THE PAGE'S MARKUP STATES, read by a standards-following HTML parser that keeps where each element
 * landed: every title, description, robots meta, canonical, `<base>`, refresh and viewport (several of
 * one is a finding), the social tags, the links the crawler cannot follow, bookmarks, forms, images,
 * pagination, AMP, analytics and placeholder text. Read from the page as stored: the rendered DOM when
 * the browser rendered it (every page check judges the rendered page), the raw HTML only when it did
 * not. Facts only, cut short; the rules in `./rules` judge them.
 */
export interface SeoPageMarkupFacts {
	/** How the parser read the stored page's head. */
	head: SeoPageHeadFacts;
	/** Every `<title>` (svg titles left out). */
	titles: SeoPageMarkupText[];
	/** Every `<meta name="description">`. */
	descriptions: SeoPageMarkupText[];
	/** Every robots meta (`robots`, `googlebot`, `bingbot`, ...), its tokens parsed. */
	robots: (SeoPageRobotsGroup & { inHead: boolean })[];
	/** Every `<link rel="canonical">`: the href as written, and the attributes Google ignores it for. */
	canonicals: { href: string; inHead: boolean; attributes: string[] }[];
	/** hreflang `<link>` elements the parser placed in `<body>` (ignored there). */
	hreflangOutsideHead: number;
	/** Every `<base>`: its href as written, or null when it has none. */
	bases: { href: string | null; inHead: boolean }[];
	/** Every `<meta http-equiv="refresh">`: the content, the delay in seconds and the target, resolved. */
	refresh: { content: string; delaySeconds: number | null; url: string | null; inHead: boolean }[];
	viewports: SeoPageViewport[];
	/** `<html lang>` as written (null without the attribute) and `<meta http-equiv="content-language">`. */
	lang: { html: string | null; contentLanguage: string | null };
	/** The Open Graph and X (Twitter) card fields, first value of each, as written. */
	openGraph: {
		title: string | null;
		type: string | null;
		image: string | null;
		url: string | null;
		description: string | null;
		siteName: string | null;
	};
	twitter: {
		card: string | null;
		title: string | null;
		description: string | null;
		image: string | null;
		site: string | null;
	};
	/**
	 * Links a crawler cannot follow or that leak a local address, by kind, with a few hrefs as written
	 * and, at the same index, each one's anchor text (`anchors`, absent on older reads), so a reader can
	 * tell which link it is (an empty address says nothing by itself). `inText` counts the ones in an
	 * article's running text (a paragraph, list or code block of an `<article>` or `<main>`, outside
	 * its navigation, header, footer and asides), absent when none is or on older reads.
	 */
	badLinks: {
		kind: SeoPageBadLinkKindValue;
		count: number;
		examples: string[];
		anchors?: string[];
		inText?: number;
	}[];
	/** Bookmarks: same-page `#fragment` links whose target is not on the page, links to a fragment of another page, and this page's element ids. */
	bookmarks: {
		missing: string[];
		missingCount: number;
		/** Links to another page's fragment: the page (resolved, no fragment) and the fragment. */
		external: { url: string; fragment: string }[];
		/** The ids (and `<a name>`s) on this page, for the bookmark links other pages hold. */
		ids: string[];
		idsTruncated: boolean;
	};
	/** Every form: where it posts (resolved, or as written when it cannot be), how, and whether it asks for a password. */
	forms: { action: string; method: string; password: boolean }[];
	formCount: number;
	/** Whether a password field sits outside any form. */
	passwordOutsideForm: boolean;
	/** The images the page shows (fallbacks in `<noscript>` and hidden ones left out), the first of them. */
	images: SeoPageMarkupImage[];
	imageCount: number;
	/** `<link rel="next">` and `<link rel="prev">` targets, resolved. */
	pagination: { next: string[]; prev: string[] };
	/** Whether the page is an AMP page (`<html amp>`), and its `rel="amphtml"` target. */
	amp: { isAmp: boolean; amphtml: string | null };
	/** A separate mobile page named by `<link rel="alternate" media>`. */
	mobileAlternate: { url: string; media: string } | null;
	/**
	 * The Google Analytics and Tag Manager ids the page loads, and the ones it counts twice: an id
	 * configured twice by inline code, or a Tag Manager container loaded twice. A `gtag.js` loader
	 * repeated is not counted: Tag Manager and gtag.js load their own copy of it for the same id.
	 */
	analytics: { ids: string[]; duplicates: string[] };
	/** The words around a "lorem ipsum" placeholder, or null when there is none. */
	loremIpsum: string | null;
	/**
	 * Plugin content and image maps; `legacy` counts the objects and embeds that need a plugin no browser
	 * runs (Flash, Silverlight, Java), absent on reads made before it was kept.
	 */
	plugins: { object: number; embed: number; applet: number; imageMaps: number; legacy?: number };
	/** Whether the page opts into the retired AJAX crawling scheme (`<meta name="fragment" content="!">`). */
	ajaxFragmentMeta: boolean;
	/** Subresources loaded with a protocol-relative URL (`//host/...`). */
	protocolRelative: { count: number; examples: string[] };
	/** The microdata and RDFa items (schema.org), within a size budget; absent on reads made before they were kept. */
	structuredItems?: SeoPageMarkupItem[];
	/** The prices and ratings the structured data states and whether the page shows them; absent on older reads. */
	markedValues?: SeoPageMarkedValues[];
	/** Whether a bound on the structured data read (size, nesting, work) cut it short; absent when it did not. */
	structuredTruncated?: boolean;
	/**
	 * Whether the parser's work bound stopped the markup read before the page's end (a crafted page that
	 * makes the parser build far more than it holds), so these facts cover only its start; absent when not.
	 */
	parseCut?: boolean;
	/**
	 * The hash of the page's layout skeleton (its container elements, not its content), which the
	 * template grouping reads; absent on reads made before it was kept.
	 */
	skeleton?: string | null;
	/**
	 * The page's markdown version named by `<link rel="alternate" type="text/markdown">`, resolved, or
	 * null; absent on reads made before it was kept.
	 */
	markdownAlternate?: string | null;
	/** The site builder or framework the page shows it was made with, or null; absent on older reads. */
	platform?: SeoSitePlatformValue | null;
	/**
	 * What the page shows of a store: its controls that put a product in the cart, and whether its text
	 * shows a price; absent on older reads.
	 */
	commerce?: { cartButtons: number; price: boolean };
}

/** What the TLS handshake with the site's host showed (the server's own read). */
export interface SeoTlsFacts {
	/** When it was read (ISO). */
	checkedAt: string;
	host: string;
	/** The certificate's validity window (ISO), null when no certificate was read. */
	validFrom: string | null;
	validTo: string | null;
	/** The protocol and cipher negotiated (`TLSv1.3`, `TLS_AES_256_GCM_SHA384`). */
	protocol: string | null;
	cipher: string | null;
	/** The issuer's organisation or common name. */
	issuer: string | null;
	/** Whether the certificate chain and host name verified, and the verification error code when not. */
	authorized: boolean;
	error: string | null;
}

/**
 * How the site's robots.txt answered at a plan: a file (`ok`), a 4xx (`client_error`: no file, which
 * allows everything), a 5xx (`server_error`), no answer in time (`timeout`), redirects that come back
 * to a URL already asked (`redirect_loop`), or any other failure (`failed`: refused, a network error,
 * a redirect chain too long).
 */
export type SeoRobotsFetchOutcomeValue =
	"ok" | "client_error" | "server_error" | "timeout" | "redirect_loop" | "failed";

/** The robots.txt fetch of the last plan (the server's own read). */
export interface SeoRobotsFetchFacts {
	/** When it was read (ISO). */
	checkedAt: string;
	/** The last answer's status, or null when nothing answered. */
	status: number | null;
	outcome: SeoRobotsFetchOutcomeValue;
	/**
	 * Plans in a row, this one included, whose read was unreachable (`server_error`, `timeout` or
	 * `redirect_loop`); 0 when this one was not.
	 */
	failures: number;
}

/**
 * One status read of a host variant or a page over another scheme: never followed, only its status
 * and `Location` kept.
 */
export interface SeoHostProbe {
	/** The URL asked (`http://host/`, `https://www.host/`, `http://host/path`). */
	url: string;
	/** The status, or null when nothing answered. */
	status: number | null;
	/** The `Location` header resolved against the URL, or null. */
	location: string | null;
	/**
	 * Why nothing answered: the host does not exist in DNS (`unresolved`), the guard refused it
	 * (`blocked`), no answer in time (`timeout`), or any other failure (`network`).
	 */
	error: "unresolved" | "blocked" | "timeout" | "network" | null;
	/**
	 * The canonical a version that answered a page names (its `Link` header, or a `<link rel=canonical>`
	 * near the top of its HTML on https), resolved; null when it names none, absent on older reads.
	 */
	canonical?: string | null;
}

/** The host variant reads of the last plan (the server's own). */
export interface SeoHostProbes {
	/** When they were read (ISO). */
	checkedAt: string;
	/** The home page over http and https, on the site's host and its `www.` twin. */
	variants: SeoHostProbe[];
	/** A few crawled pages over plain http, each with its page key. */
	pages: (SeoHostProbe & { pageKey: string })[];
	/**
	 * A few hreflang alternates the site's pages name on OTHER domains (one page per domain), read for
	 * the return-link check; absent on older reads.
	 */
	hreflang?: SeoHreflangProbe[];
}

/** One hreflang alternate on another domain, as the plan read it. */
export interface SeoHreflangProbe {
	/** The alternate's URL as a page of the site names it. */
	url: string;
	/** Its page key. */
	key: string;
	/** The status, or null when nothing answered (or that domain's robots.txt kept the crawler off). */
	status: number | null;
	/**
	 * The page keys the alternate's own hreflang names (its HTML head and `Link` header); null when it
	 * was not read as a page (no 2xx HTML answer, robots.txt refused it).
	 */
	names: string[] | null;
}

/**
 * WHAT THE CONTENT RULES READ FROM A PAGE'S MAIN TEXT, worked out when the page is read so the text
 * itself is never kept for them: a fingerprint for near-duplicate pages, the languages the text reads
 * as, and how easy it is to read. Computed from the stored page (the rendered one whenever the browser
 * rendered it).
 */
export interface SeoPageTextFacts {
	/**
	 * The MinHash signature of the main text's word three-grams (numbers and dates folded), base64 of
	 * little-endian 32-bit values; null when the text is too short to compare.
	 */
	minhash: string | null;
	/**
	 * The languages the main text plausibly reads as, the likeliest first (ISO 639-1, or 639-3 for a
	 * language without a two-letter code); null when the text is too short to tell.
	 */
	languages: string[] | null;
	/** The reading ease score (Flesch, the formula of the text's language) and that language; null when no formula fits. */
	readability: { language: string; score: number } | null;
	/**
	 * True when the main text is only a shop platform's empty listing notice ("No products available
	 * yet"); absent otherwise, and on pages read before it was kept.
	 */
	emptyListing?: true;
}

/**
 * The words a spelling check of a page did not find in its language's dictionary, after the words it
 * never judges (names, codes, addresses, words with digits) were left out. The site-wide rule drops a
 * word that several pages share (a term of the site, not a typo).
 */
export interface SeoPageSpellingFacts {
	/** The dictionary's language (ISO 639-1). */
	language: string;
	/** The main text words judged. */
	checked: number;
	/** The unknown words of the main text (lowercased), the most frequent first, each with its count. */
	text: { word: string; count: number }[];
	/** The unknown words of the title and of the H1 (lowercased), each absent from the main text. */
	title: string[];
	h1: string[];
}

/** One error the AMP validator found on an AMP page. */
export interface SeoPageAmpError {
	/** The validator's error code (`MANDATORY_TAG_MISSING`, `DISALLOWED_TAG`, ...). */
	code: string;
	/** The error's parameters (the tag, the attribute), cut short. */
	params: string[];
	line: number;
}

/** What the AMP validator found on an AMP page's served HTML. */
export interface SeoPageAmpFacts {
	/** The validator's errors (warnings left out), the first of them. */
	errors: SeoPageAmpError[];
	errorCount: number;
}

/** What one of the project's custom search or extraction patterns found on a page. */
export interface SeoPageCustomResult {
	/** The pattern's id in the project's settings. */
	id: string;
	/** How many times it matched. */
	count: number;
	/** The values it extracted (an extraction pattern's), the first of them, cut short. */
	values: string[];
}

/**
 * One problem the grammar check (Harper, on a member's computer only) found in a page's English text:
 * the lint's kind as Harper names it (`Grammar`, `Repetition`, `Agreement`, ...), the text it is about
 * and its first suggested replacement, each cut short. No English message is kept.
 */
export interface SeoPageGrammarIssue {
	kind: string;
	text: string;
	suggestion: string | null;
}

/** What the grammar check found on a page's title, H1 and main text. */
export interface SeoPageGrammarFacts {
	/** The characters of text checked. */
	checked: number;
	/** How many problems it found. */
	count: number;
	/** The first of them. */
	issues: SeoPageGrammarIssue[];
}

/**
 * What one of the project's custom JavaScript snippets answered on a page (run on a member's computer
 * only, in an isolated world of the rendered page): its value as text, cut short, or why there is none.
 */
export interface SeoPageScriptResult {
	/** The snippet's id in the project's settings. */
	id: string;
	/** The value it returned as text (JSON for an object), or null. */
	value: string | null;
	/** Why it answered nothing: it ran out of time or threw; null when it answered. */
	error: "timeout" | "error" | null;
}

/**
 * WHAT THE OPTIONAL CHECKS FOUND ON A PAGE: spelling (on the server only for pages with search
 * traffic, every page on a member's computer), AMP validation (AMP pages only), the project's own
 * search and extraction patterns, and - on a member's computer only - grammar and the project's custom
 * JavaScript snippets. Each is absent when it did not run.
 */
export interface SeoPageCheckFacts {
	spelling?: SeoPageSpellingFacts | null;
	amp?: SeoPageAmpFacts | null;
	custom?: SeoPageCustomResult[];
	grammar?: SeoPageGrammarFacts | null;
	scripts?: SeoPageScriptResult[];
}

/**
 * WHAT THE SITE AUDIT READS FROM A PAGE'S LATEST FETCH, beyond the snapshot: rewritten on EVERY read
 * (a snapshot is written only when the compared fields change, so a field the change history does not
 * compare would go stale there). Plain data, no English: the rules (`./audit`, `./rules`)
 * judge it.
 */
export interface SeoPageAuditFacts {
	/** When the fetch was made (ISO). */
	readAt: string;
	/** Every hop of the fetch, the final one included (a loop shows a URL twice). */
	redirectChain: SeoPageRedirectHop[];
	/**
	 * How long the page's own answer took (the last hop, its body read; redirects before it are left
	 * out on reads made since 2026-10-09), in ms, and how many bytes the body held.
	 */
	responseMs: number;
	sizeBytes: number;
	/**
	 * Where the fetch was made from, so a response time says where it was measured: the member's own
	 * computer (a desktop crawl), the platform's server in a region of the world, or the server when the
	 * deployment names no region; absent on reads made before it was kept.
	 */
	measuredFrom?: SeoMeasuredFromValue;
	/** Whether a 2xx body held an HTML document its `Content-Type` did not name as HTML; absent when not. */
	htmlUnlabelled?: boolean;
	/**
	 * On an HTML file over what Googlebot reads (2 MB), what the cut leaves out: whether a head element
	 * search engines read (title, description, robots, canonical, hreflang) or part of the main text sits
	 * past the cut; absent on a smaller file or an older read.
	 */
	htmlCut?: { head: boolean; mainText: boolean };
	/**
	 * The page fields the snapshot holds but does not compare (so they can go stale there), as this
	 * fetch read them; null when no HTML was read.
	 */
	page: {
		h1Count: number;
		/** H1s holding neither text nor an image with alt text; absent on reads made before it was counted. */
		h1Empty?: number;
		lang: string;
		viewport: string;
		hasOpenGraph: boolean;
		hasTwitterCard: boolean;
		images: number;
		imagesMissingAlt: number;
		/** Links to the site's own pages and to other sites the page holds, before any cap or dedupe. */
		internalLinks: number;
		/** Absent on reads made before it was kept. */
		externalLinks?: number;
	} | null;
	/** The response headers the audit reads, null when absent. */
	headers: {
		strictTransportSecurity: string | null;
		contentSecurityPolicy: string | null;
		xContentTypeOptions: string | null;
		xFrameOptions: string | null;
		referrerPolicy: string | null;
		/** The `rel="canonical"` target of a `Link` header, absolute, or null. */
		linkCanonical: string | null;
		/** `Content-Type`, `Content-Encoding`, `Cache-Control`, `Content-Language` and `Refresh`; absent on reads made before they were kept. */
		contentType?: string | null;
		contentEncoding?: string | null;
		cacheControl?: string | null;
		contentLanguage?: string | null;
		refresh?: string | null;
		/** The hreflang alternates a `Link` header names (`rel="alternate"; hreflang=...`), absolute; absent on older reads. */
		linkHreflang?: SeoPageHreflang[];
	};
	/** The `X-Robots-Tag` directives per crawler; absent on reads made before they were kept. */
	robotsHeader?: SeoPageRobotsGroup[];
	/** What the page's markup states; absent on reads made before it was kept, null when no HTML was read. */
	markup?: SeoPageMarkupFacts | null;
	/** Whether the body was HTML that was read; the fields below are empty when it was not. */
	html: boolean;
	/** Every `<link rel="canonical">` target, absolute, in document order. */
	canonicals: string[];
	/** The hreflang alternates as written. */
	hreflang: SeoPageHreflang[];
	/** The JSON-LD blocks, in document order, within a size budget. */
	jsonLd: SeoPageJsonLdBlock[];
	/** `http:` subresources on the https page: scripts, frames, stylesheets (active) and media (passive). */
	mixedContent: { active: number; passive: number; examples: string[] };
	/** The images the audit judges (fallbacks inside `<noscript>` left out). */
	images: {
		total: number;
		/** Images with neither width and height attributes nor a sized style. */
		missingDimensions: number;
		/** Up to five of them, by URL as written. */
		missingDimensionsExamples: string[];
		/** The first content image before much text (the likely largest paint), when it is lazy-loaded. */
		lazyHero: { src: string; method: Exclude<SeoPageLazyMethodValue, "none"> } | null;
	};
	/** What the browser render found beside the raw HTML; absent on reads made before rendering, null when no HTML was read. */
	render?: SeoPageRenderFacts | null;
	/** What the content rules read from the main text; absent on reads made before it was kept, null when no HTML was read. */
	text?: SeoPageTextFacts | null;
	/** What the optional checks found; absent when none ran. */
	checks?: SeoPageCheckFacts | null;
}

/** One sitemap file as the plan read it, for the sitemap hygiene rules. */
export interface SeoSitemapFileFacts {
	/** The file's URL. */
	url: string;
	/** Page URLs it listed. */
	urls: number;
	/** How many of them carried a `<lastmod>`. */
	withLastmod: number;
	/** How many distinct `<lastmod>` values (to the day) they carried. */
	distinctLastmod: number;
	/**
	 * How the plan found the file: a `Sitemap:` line of robots.txt, a sitemap index (`declared` when
	 * that index was itself named by robots.txt), or a common path tried on every site. Absent on
	 * reads made before it was kept, as are the fields below.
	 */
	source?: SeoSitemapSourceValue;
	/** The last hop's status (0 when nothing answered). */
	status?: number;
	/** Why the file yielded no sitemap: not a sitemap at all, an empty answer, or a sitemap without its namespace. */
	invalid?: "not_sitemap" | "empty" | "namespace" | "malformed" | null;
	/** Listed URLs on a host that is not the site's, or outside the file's folder, with a few of them. */
	outOfScope?: { count: number; examples: string[] };
	/** `<lastmod>` values that are not W3C Datetime, with a few of them, and how many lie in the future. */
	lastmodInvalid?: { count: number; examples: string[] };
	lastmodFuture?: number;
	/** URLs carrying a tag Google ignores (`priority`, `changefreq`, a retired image tag). */
	deprecatedTags?: number;
	/** URLs over the image limit, videos missing a required tag, and news entries older than two days. */
	extension?: { imagesOver: number; videosIncomplete: number; newsStale: number };
	/** Listed URLs an earlier sitemap file of the plan listed too. */
	repeated?: number;
	/**
	 * The hreflang alternates its entries carry: how many entries carry them, whether the XHTML namespace
	 * was missing, and the entries whose set is incomplete (no self entry, or a listed alternate carrying
	 * a different set); absent when no entry carries any, and on reads made before they were kept.
	 */
	hreflang?: { urls: number; namespaceMissing: boolean; incomplete: number; examples: string[] };
}

/** How a plan found a sitemap file. */
export type SeoSitemapSourceValue = "robots" | "index" | "declared_index" | "guess";

/** The region of the world the platform's crawl server runs in, as a deployment names it. */
export type SeoCrawlRegionValue =
	"africa" | "asia" | "europe" | "middle_east" | "north_america" | "oceania" | "south_america";

/** Where a page was fetched from: the member's computer, the server in a region, or the server. */
export type SeoMeasuredFromValue = "computer" | "server" | SeoCrawlRegionValue;

/** What a request for a page that cannot exist answered: a catch-all answers 200 instead of 404. */
export interface SeoSoft404Probe {
	/** When it was asked (ISO). */
	checkedAt: string;
	/** The probe URL. */
	url: string;
	/** The first hop's status, or 0 when nothing answered. */
	status: number;
	/** The last hop's status, or 0 when nothing answered. */
	finalStatus: number;
	/** The page key the probe landed on after redirects, or null when it did not move. */
	landedOn: string | null;
	/** True when the page it answered with says `noindex` (header or meta); absent otherwise. */
	noindex?: boolean;
}

/** Whose robots.txt group a crawl obeys: its own token's (else `*`), or a search engine's. */
export type SeoCrawlRobotsGroupValue = "own" | "googlebot" | "bingbot";

/**
 * Which crawler the crawl presents itself as: its own honest User-Agent, a search engine's (Google's
 * smartphone or desktop crawler, Bing's), or a member's own string. A preset also chooses the robots.txt
 * group obeyed and the viewport pages render at; on the platform's servers the HTTP User-Agent is
 * always the crawler's own.
 */
export type SeoCrawlUserAgentPresetValue =
	"own" | "googlebot_smartphone" | "googlebot_desktop" | "bingbot" | "custom";

/** One regular expression URL rewrite (RE2 syntax, `$1` in the replacement names a group). */
export interface SeoUrlRewrite {
	pattern: string;
	replace: string;
}

/**
 * One custom JavaScript snippet, run on a member's computer in an isolated world of each rendered page.
 * Only an owner or admin of the project's organization may save one, and it runs only on the computer
 * of such a member who switched snippets on there; who last edited it is kept and shown.
 */
export interface SeoCustomScript {
	id: string;
	name: string;
	/** The body of an async function whose return value is kept. */
	code: string;
	/** The user who last changed its name or code, or null before that was kept. */
	editedBy: string | null;
	/** That user's name as it was shown then, or null. */
	editedByName: string | null;
	/** When it was last changed (ISO), or null. */
	editedAt: string | null;
}

/** One AI prompt run over each page's main text at the audit, charged to the project's payer. */
export interface SeoAiPagePrompt {
	id: string;
	name: string;
	prompt: string;
}

/** What only a crawl run on a member's computer does; the platform's servers ignore it. */
export interface SeoCrawlDesktopSettings {
	/** Requests per second to the site; null for the server's polite pace. Never faster than `Crawl-delay`. */
	requestsPerSecond: number | null;
	/** Whether a screenshot of every rendered page is kept on the computer. */
	screenshots: boolean;
	/** Whether every page's raw and rendered HTML is kept on the computer. */
	storeHtml: boolean;
	/** Whether the English text of every page is checked for grammar. */
	grammar: boolean;
	/** The project's custom JavaScript snippets. */
	scripts: SeoCustomScript[];
}

/**
 * A PROJECT'S CRAWL SETTINGS, set by its members: which URLs are crawled and how a URL is cleaned
 * before it is keyed. Patterns are robots.txt-style (`*` any characters, `$` the end) matched against a
 * URL's path and query, so a pattern can never be slow to match.
 */
export interface SeoCrawlSettings {
	/** When any is set, only URLs matching one are crawled (the home page always is). */
	include: string[];
	/** URLs matching one are never crawled. */
	exclude: string[];
	/** Query parameters dropped from every URL found (a trailing `*` names a prefix, `sort*`). */
	removeParams: string[];
	/** Whether every query parameter is dropped. */
	removeAllParams: boolean;
	/** Whether URL paths are lowercased. */
	lowercasePaths: boolean;
	/**
	 * Whose robots.txt group the crawl obeys. A search engine's group is honoured only on a site the
	 * project verified it owns; otherwise the crawler's own group is obeyed.
	 */
	robotsGroup: SeoCrawlRobotsGroupValue;
	/** The members' own search and extraction patterns, run on every page the crawl reads. */
	customChecks: SeoCustomCheck[];
	/**
	 * Whether the audit compares the pages' meaning (an AI embedding of each page's main text), each
	 * page's embedding charged to the project's payer in credits. Off by default.
	 */
	semanticChecks: boolean;
	/** Named URL-pattern groups (`/blog/`, `*\/product/*`) the issues and pages can be filtered by. */
	segments: SeoCrawlSegment[];
	/**
	 * For a big site: at most this many pages of one URL pattern (`/blog/*`) are crawled, pages with
	 * search traffic always kept; null crawls every page the cap allows.
	 */
	samplePerPattern: number | null;
	/** Which crawler the crawl presents itself as. */
	userAgentPreset: SeoCrawlUserAgentPresetValue;
	/** The member's own User-Agent, for the `custom` preset; null otherwise. */
	customUserAgent: string | null;
	/** Regular expression rewrites applied to every URL found, in order, before it is keyed. */
	urlRewrites: SeoUrlRewrite[];
	/** Whether the site's subdomains are crawled as part of it (each under its own robots.txt). */
	subdomainsInternal: boolean;
	/** How many links deep from the pages found another way the crawl follows; null for no limit. */
	maxDepth: number | null;
	/** How long a rendered page is left to run after it settles before it is read, in ms. */
	renderWaitMs: number;
	/** AI prompts run over each page's main text at the audit (opt-in: none by default). */
	aiPrompts: SeoAiPagePrompt[];
	/**
	 * The audit thresholds the project changed (title widths, little text, slow answer...), by key;
	 * a key left out keeps the tuned default. Only an owner or admin may change them.
	 */
	thresholds: Partial<Record<string, number>>;
	/** What only a crawl on a member's computer does. */
	desktop: SeoCrawlDesktopSettings;
	/**
	 * Where the project's scheduled crawls run: on SEOStudio's servers (`cloud`), or on the members' own
	 * server (`own_server`), where `seostudio agent` takes them. A standalone crawl ignores it.
	 */
	runner: SeoCrawlRunnerValue;
}

/** Where a project's scheduled crawls run. */
export type SeoCrawlRunnerValue = "cloud" | "own_server";

/** What a custom pattern looks for: pages that contain it, pages that do not, or values to extract. */
export type SeoCustomCheckModeValue = "contains" | "absent" | "extract";

/**
 * How a custom pattern is matched against the page's HTML (the rendered page whenever the browser
 * rendered it): plain text (case-insensitive), a regular expression (RE2 syntax, so a match is never
 * slow), or a CSS selector.
 */
export type SeoCustomCheckMatchValue = "text" | "regex" | "css";

/** One of a project's custom search or extraction patterns. */
export interface SeoCustomCheck {
	/** A stable id the results are stored under. */
	id: string;
	/** The members' name for it. */
	name: string;
	mode: SeoCustomCheckModeValue;
	match: SeoCustomCheckMatchValue;
	pattern: string;
	/** For a CSS extraction, the attribute whose value is extracted instead of the element's text. */
	attribute: string | null;
}

/** How one AI agent file of the site answered at a plan. */
export type SeoAgentFileOutcomeValue =
	"absent" | "ok" | "server_error" | "soft_404" | "no_h1" | "no_links" | "invalid_json";

/**
 * THE SITE'S FILES FOR AI AGENTS at the last plan: `/llms.txt`, the declared agent files under
 * `/.well-known/`, and whether the home page answers a request for markdown with markdown.
 */
export interface SeoAgentFilesFacts {
	/** When they were read (ISO). */
	checkedAt: string;
	/** Each file asked, by path, with its status (null when nothing answered) and what it was judged. */
	files: { path: string; status: number | null; outcome: SeoAgentFileOutcomeValue }[];
	/** Whether the home page answered `Accept: text/markdown` with markdown. */
	markdownNegotiated: boolean;
}

/** One saved segment: a name and the robots.txt-style patterns a page's URL matches it by. */
export interface SeoCrawlSegment {
	name: string;
	patterns: string[];
}

/** What an audit changed for one rule. */
export interface SeoAuditRunChange {
	/** Issues new to the audit. */
	found: number;
	/** Issues the audit no longer found. */
	fixed: number;
	/** Issues found again after an earlier audit had them fixed. */
	regressed: number;
}

/**
 * What a page references: an image, a stylesheet, a script, a font, an icon, a media file (video,
 * audio, a track), the `og:image`, a request its render could not complete that is none of those
 * (`other`: data and API requests), a page on another site it links to (`link`), a document it links
 * to (`document`: a PDF, an office file) on the site or off it, or a spelling of a link to a page of the
 * site that differs from the URL the crawler reads that page at (`spelling`: a trailing slash, a doubled
 * slash), asked once without following where it leads.
 */
export type SeoResourceKindValue =
	| "image"
	| "stylesheet"
	| "script"
	| "font"
	| "icon"
	| "media"
	| "og_image"
	| "other"
	| "link"
	| "document"
	| "spelling";

/** How a resource was asked for: a HEAD, or a GET where the HEAD was refused or told too little. */
export type SeoResourceCheckMethodValue = "head" | "get";

/**
 * Why a resource check got no usable answer. `dns_not_found` is a host that does not exist in DNS
 * (NXDOMAIN), told apart from a resolver that could not answer for now (`network`).
 */
export type SeoResourceCheckErrorValue =
	"timeout" | "blocked" | "network" | "too_many_redirects" | "dns_not_found";

/**
 * The caching and compression headers a check of a file a page loads keeps, for the compression and
 * cache lifetime checks (each cut to 200 characters), and what an image's first bytes said beyond its
 * pixel size. An outbound link keeps none.
 */
export interface SeoResourceHeaders {
	cacheControl: string | null;
	expires: string | null;
	contentEncoding: string | null;
	/**
	 * A compressed script or stylesheet's unpacked size (what Googlebot's per-file limit counts), read
	 * just past that limit; absent when it was not measured.
	 */
	decodedBytes?: number;
	/**
	 * Whether an image's first bytes show an animated GIF (one that loops or shows a second frame);
	 * absent when they were not read.
	 */
	animated?: boolean;
}

/**
 * One Lighthouse audit of a lab test, as the site audit's `lh_*` rules read it: Lighthouse's own score,
 * the savings it estimated, and a few examples. Plain data: no English.
 */
export interface SeoLabAudit {
	/** Lighthouse's score, 0 to 1 (below 0.9 is a failure), or null when it does not apply. */
	score: number | null;
	/** The largest metric saving Lighthouse estimated (FCP, LCP, TBT or INP), in ms. */
	savingsMs: number;
	/** The bytes Lighthouse estimated could be saved. */
	savingsBytes: number;
	/** The audit's measured value, when it has one (main-thread time, a chain's length, the CLS). */
	value: number | null;
	/** The checks of a checklist audit that failed, by Lighthouse's key. */
	failedChecks: string[];
	/** A few URLs it names, and how many it names in all. */
	urls: string[];
	urlCount: number;
	/** A few elements it names, as CSS selectors. */
	elements: string[];
}
