import type {
	SeoCrawlRegionValue,
	SeoPageA11yFacts,
	SeoPageDomFacts,
	SeoPageHeading,
	SeoPageHreflang,
	SeoPageLinkPlacementValue,
	SeoPageMarkupFacts,
	SeoPageRedirectHop,
	SeoPageRenderOutcomeValue,
	SeoPageRenderResourceFailure,
	SeoPageScriptResult,
	SeoTlsFacts
} from "./facts";
import type { SeoHostGate } from "./host-gate";

/**
 * The shapes the crawler and the audit share: what an extractor reads from a page, what a fetch
 * answered, what a browser render returns, and what a crawl reaches outside itself.
 *
 * Types only: this file loads nothing at runtime.
 */

/** A calendar day in UTC, `YYYY-MM-DD`. */
export type IsoDate = string;

/** One link found on a page. */
export interface ExtractedLink {
	/** The absolute URL the link points at. */
	href: string;
	/** The anchor text, else an image's alt, else the link's accessible label; whitespace collapsed. */
	anchor: string;
	placement: SeoPageLinkPlacementValue;
	nofollow: boolean;
}

/** Everything the extractor reads from one HTML page. */
export interface ExtractedPage {
	title: string;
	metaDescription: string;
	h1: string;
	h1Count: number;
	/** H1s holding neither text nor an image with alt text; absent on a reading made before it was counted. */
	h1Empty?: number;
	headings: SeoPageHeading[];
	/** The canonical link's absolute URL, or empty. */
	canonical: string;
	/** The `robots` (and `googlebot`) meta directives, lowercased and joined, or empty. */
	metaRobots: string;
	lang: string;
	viewport: string;
	schemaTypes: string[];
	hreflang: SeoPageHreflang[];
	hasOpenGraph: boolean;
	hasTwitterCard: boolean;
	images: number;
	imagesMissingAlt: number;
	/** `YYYY-MM-DD`, or null when the page states none. */
	datePublished: IsoDate | null;
	dateModified: IsoDate | null;
	links: ExtractedLink[];
	/** The page's main text, boilerplate stripped, one block per line. */
	mainText: string;
	wordCount: number;
	/** Whether the page looks like a bot challenge rather than the page itself. */
	botWall: boolean;
	/** What the site audit reads beyond the snapshot fields. */
	audit: ExtractedAuditFacts;
	/**
	 * What the markup states, read by a standards-following parser (`./extract-markup`); absent on a
	 * reading made by an app from before it was read.
	 */
	markup?: ExtractedMarkup;
}

/** What a subresource is, for the resource checks. */
export type ExtractedResourceKind =
	"image" | "stylesheet" | "script" | "font" | "icon" | "media" | "og_image";

/** One subresource a page references: absolute http(s) URL, as resolved against the page. */
export interface ExtractedResource {
	url: string;
	kind: ExtractedResourceKind;
}

/**
 * The markup facts of one read, and the subresources it references (handed to the resource checks,
 * never stored with the page).
 */
export interface ExtractedMarkup extends SeoPageMarkupFacts {
	resources: ExtractedResource[];
}

/** The headers of a fetch the site audit reads. */
export interface FetchedAuditHeaders {
	strictTransportSecurity: string | null;
	contentSecurityPolicy: string | null;
	xContentTypeOptions: string | null;
	xFrameOptions: string | null;
	referrerPolicy: string | null;
	/** The raw `Link` header. */
	link: string | null;
	/**
	 * `Content-Type`, `Content-Encoding`, `Cache-Control`, `Content-Language` and `Refresh`; every fetch
	 * reads them, a reading from an app from before they were read lacks them.
	 */
	contentType?: string | null;
	contentEncoding?: string | null;
	cacheControl?: string | null;
	contentLanguage?: string | null;
	refresh?: string | null;
}

/** What the extractor reads for the site audit alone. */
export interface ExtractedAuditFacts {
	/** Every `<link rel="canonical">` target, absolute, in document order. */
	canonicals: string[];
	/** The JSON-LD blocks' raw text, in document order. */
	jsonLd: string[];
	/** `http:` subresources: scripts, frames, stylesheets, objects (active) and media (passive). */
	mixedActive: string[];
	mixedPassive: string[];
	/** Images outside `<noscript>`. */
	images: number;
	/** Of them, the ones with no size (no width and height attributes, no sized style). */
	unsizedImages: string[];
	/** The first content image before much text, when it is lazy-loaded, and how. */
	lazyHero: { src: string; method: "native" | "javascript" } | null;
}

/** What one fetch (redirects followed) answered. */
export interface FetchedResource {
	requestedUrl: string;
	/** Where the last hop landed. */
	finalUrl: string;
	/** The FIRST hop's status (a redirecting URL is a redirect), or 0 when nothing answered. */
	status: number;
	/** The last hop's status. */
	finalStatus: number;
	/** Every hop, the final one included. */
	chain: SeoPageRedirectHop[];
	contentType: string | null;
	xRobotsTag: string | null;
	/** The last hop's headers the site audit reads, null where absent (all null when nothing answered). */
	auditHeaders: FetchedAuditHeaders;
	/** The last hop's body, capped; null when nothing was read, or when a sink took it as it arrived. */
	body: Uint8Array | null;
	truncated: boolean;
	sizeBytes: number;
	/** How long the last hop took, its body read (the whole chain's time when it failed). */
	responseMs: number;
	error: "timeout" | "blocked" | "network" | "too_many_redirects" | null;
	/** The last hop's `Retry-After` header, when it sent one (a 429 or 503 asking for a pause). */
	retryAfter?: string | null;
	/** Whether a 2xx body holds an HTML document its `Content-Type` does not name as HTML; absent when not. */
	htmlUnlabelled?: boolean;
	/** On HTML over what Googlebot reads, what its cut leaves out (`./reading` `htmlCutOf`); absent when not over. */
	htmlCut?: { head: boolean; mainText: boolean };
	/**
	 * On a 403 to the browser User-Agent naming the crawler a bot, whether the site served the same page
	 * to the crawler's own plain User-Agent (`./reading` `answersPlainAgent`): it refuses the string,
	 * not the crawler's address. Absent otherwise.
	 */
	botAgentRefused?: boolean;
}

/** A `fetch`-shaped transport with the guard's timeout argument (`safeFetch` in production). */
export type SeoCrawlFetcher = (
	url: string,
	init: RequestInit,
	timeoutMs: number
) => Promise<Response>;

/** What a browser is asked to render: the page, and the raw HTML its own fetch already read. */
export interface SeoRenderRequest {
	/** The page's URL (where its raw fetch landed, on the page itself). */
	url: string;
	/** The raw HTML the crawler read: the browser renders exactly this document, never fetching it again. */
	html: string;
	/** The raw answer's status (2xx). */
	status: number;
	/** The raw answer's `Content-Security-Policy`, so the page's scripts run under the policy it set. */
	contentSecurityPolicy: string | null;
	/** The crawler's own User-Agent; the browser sends it inside a phone Chrome's. */
	userAgent: string;
	/**
	 * Whether a subresource may be fetched: the site's robots.txt for its own hosts (Google obeys it for
	 * scripts, styles and data too). A refused script, style or data request is recorded as blocked.
	 */
	allowResource: ((url: string) => boolean) | null;
	/**
	 * Waits for the request's turn before a subresource is fetched: the per-host pace every crawl of the
	 * site's own host shares (the server's). Absent where a crawl paces only itself (the desktop app).
	 */
	paceResource?: (url: string) => Promise<void>;
	/** The device the page is rendered as: a phone (the default, as Google renders) or a desktop. */
	device?: "mobile" | "desktop";
	/** Whether a phone render runs the in-page probe once the DOM is read (default true). */
	probe?: boolean;
	/** Which accessibility rules (axe-core) run on a phone render: the search-relevant subset, all, or none. */
	accessibility?: "seo" | "all" | null;
	/**
	 * The site's sign-in headers for a request the page makes: what the members set for the project's
	 * own hosts, null elsewhere (`./site-access`). Absent when the site asks for none.
	 */
	siteHeaders?: (url: string) => Record<string, string> | null;
	/** Whether the rendered page is also captured as a screenshot (a single page analysis). */
	screenshot?: boolean;
	/**
	 * A screenshot for a page's content (the content writer's images): the page's images are loaded,
	 * its cookie banner is dismissed (reject), the shot is cropped to an element or region and the boxes
	 * of the elements to mark and to blur are measured. The page is rendered at twice the pixel density.
	 */
	capture?: SeoRenderCapture;
	/**
	 * How long the page is left to run once it settled before its DOM is read, in ms: the members' render
	 * wait, kept within the render's time limit. None by default.
	 */
	waitMs?: number;
	/**
	 * The project's custom JavaScript snippets, run once the DOM is read in an isolated world the page's
	 * own scripts cannot reach, each bounded in time and output (a member's computer only).
	 */
	scripts?: readonly SeoRenderScript[];
	/**
	 * Whether the browser asks for the document itself, as a visitor's browser does (its own headers,
	 * the page's cookies, a bot check's script let run and its reload followed), every request still
	 * through the guard: for a page whose plain fetch a bot check refused. `html` and `status` are then
	 * not read; the answer carries the document's own status (`documentStatus`).
	 */
	fetchDocument?: boolean;
}

/** One custom JavaScript snippet as the render runs it: its id and its code. */
export interface SeoRenderScript {
	id: string;
	code: string;
}

/** What a browser answered for one page, before the extractor reads it. */
export interface SeoBrowserRender {
	outcome: SeoPageRenderOutcomeValue;
	/** Why it failed, or null. */
	error: string | null;
	/** The rendered DOM, serialized; null when the render failed. */
	html: string | null;
	/** The URL of the document the browser ended on (a script may navigate away). */
	finalUrl: string;
	renderMs: number;
	/** Uncaught script errors and console errors, cut short. */
	consoleErrors: string[];
	/** Scripts, stylesheets and data requests the page could not load. */
	failedResources: SeoPageRenderResourceFailure[];
	/** Requests the guard refused (a private address, a scheme other than https): never sent. */
	blockedRequests: number;
	/**
	 * Requests a host refused for the asker's rate limit (a 429, or a 403 saying no request is left):
	 * the errors a page logs for them are the crawl's own doing. Absent from a render made before it.
	 */
	rateLimitedRequests?: number;
	/** What the in-page probe measured, or null when it did not run (or could not, in its time). */
	dom?: SeoPageDomFacts | null;
	/** What the accessibility checks found, or null when they did not run. */
	a11y?: SeoPageA11yFacts | null;
	/** The screenshot asked for: a JPEG, base64; null when it could not be taken. */
	screenshot?: string | null;
	/** What the custom JavaScript snippets answered, when any ran. */
	scripts?: SeoPageScriptResult[] | null;
	/** The content screenshot asked for (`capture`), or null when it could not be taken. */
	capture?: SeoRenderCaptureResult | null;
	/**
	 * With `fetchDocument`: the status of the last document the browser got for the page (after its
	 * redirects and a bot check's reload), or null when none answered.
	 */
	documentStatus?: number | null;
}

/** An element a content screenshot looks for: by CSS selector, or by the text it holds. */
export interface SeoCaptureTarget {
	selector?: string;
	text?: string;
}

/** What a content screenshot captures. */
export interface SeoRenderCapture {
	/** The element the shot is cropped to (with a margin); the top of the page when null. */
	focus: SeoCaptureTarget | null;
	/** The elements whose boxes are measured to mark them. */
	highlights: SeoCaptureTarget[];
	/**
	 * CSS selectors of elements to blur. Emails, phone numbers and filled form fields are always measured
	 * to blur. A fixed or sticky element a selector names (an overlay over the page) is hidden instead.
	 */
	mask: string[];
	/** Capture the whole page (capped) rather than the first screen, when there is no focus. */
	fullPage: boolean;
	/** The consent script (DuckDuckGo autoconsent, reject) run before the shot; null runs only the built-in dismissal. */
	consentScript: string | null;
	/** Also read the site's logo and brand colours (the featured template's draft). */
	brand: boolean;
	/**
	 * The visitor the page is shown to: its locale (e.g. `en-US`), its time zone and the `Accept-Language`
	 * it sends, so prices, dates and words show as in the project's market. The crawler's own locale
	 * (en-US, UTC, no language asked for) when omitted.
	 */
	visitor?: { locale: string; timezone: string; acceptLanguage: string };
}

/** A rectangle in a content screenshot's own pixels. */
export interface SeoCaptureBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A fixed or sticky element that lies over the focus or a marked element as a visitor sees the page. */
export interface SeoCaptureCover {
	/** What it covers: the focus, or the index of the marked element. */
	target: "focus" | number;
	/** A CSS selector of the covering element (its id, else its tag and first classes). */
	selector: string;
	/** The start of its text, to recognise it. */
	text: string;
}

/** What a content screenshot answered. */
export interface SeoRenderCaptureResult {
	/** The PNG, base64; null when no shot could be taken. */
	png: string | null;
	width: number;
	height: number;
	/** Whether the focus element was found (false: the shot is the first screen). */
	focusFound: boolean;
	/** Each highlight's box in the shot, in order; null when it was not found or is outside the shot. */
	highlights: (SeoCaptureBox | null)[];
	/** The boxes to blur. */
	masks: SeoCaptureBox[];
	/** What happened to a consent banner. */
	consent: "dismissed" | "none" | "failed";
	/** The fixed or sticky elements over the focus or a marked element (the proof may be hidden under them). */
	covered: SeoCaptureCover[];
	/** The site's logo and colours, when asked for. */
	brand: {
		logos: string[];
		themeColor: string | null;
		cssColors: { name: string; value: string }[];
		ctaColors: string[];
	} | null;
}

/** Renders one page in a browser. Never throws: a failure is an outcome. */
export type SeoPageRenderer = (request: SeoRenderRequest) => Promise<SeoBrowserRender>;

/**
 * Reads the TLS certificate and handshake of a host (the host's own probe). Never throws: null
 * when the host is refused by the guard or nothing answered.
 */
export type SeoTlsProbe = (host: string) => Promise<SeoTlsFacts | null>;

/**
 * Reads the status and `Location` of one plain `http://` URL through the guard, redirects never
 * followed (`safePlainHttpGet` in production). Throws on failure, as the guarded transport does.
 */
export type SeoHttpProbe = (
	url: string,
	headers: Record<string, string>,
	timeoutMs: number
) => Promise<{ status: number; location: string | null }>;

/** What the crawler reaches outside itself, injectable so tests never touch the network. */
export interface SeoCrawlDeps {
	/** The guarded transport; every hop of every redirect goes through it. */
	fetch: SeoCrawlFetcher;
	/** The browser every page is rendered in, its every request through the same guard. */
	render: SeoPageRenderer;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	/** The TLS read of the site's host at each plan the server makes; without one the last read stands. */
	tls?: SeoTlsProbe;
	/**
	 * The plain-http status read for the host variant checks at each plan the server makes; without one
	 * nothing is read over http and the last reads stand.
	 */
	httpProbe?: SeoHttpProbe;
	/**
	 * The pace every crawl of a host shares (Redis on the server). Without one, a crawl only pauses
	 * between its own requests.
	 */
	hostGate?: SeoHostGate;
	/**
	 * The region of the world the server's crawl runs in, as the deployment names it; without one, or
	 * when it names none, a response time says only that the server measured it.
	 */
	region?: () => Promise<SeoCrawlRegionValue | undefined>;
}
