import { seoCrawlerLimits, seoResourceCheckLimits } from "./config";
import type {
	SeoCrawlRobotsGroupValue,
	SeoCrawlUserAgentPresetValue,
	SeoCustomCheckMatchValue,
	SeoCustomCheckModeValue
} from "./facts";

import { SEO_ROBOTS_MAX_BYTES } from "./robots";

/**
 * The bounds a reading carried to the server keeps. Far above any real page: they exist so one upload
 * can never be unbounded, and a page past them is read the same way minus the overflow. In a file of
 * its own so the route's validator loads none of the extractor.
 */
export const SEO_READING_LIMITS = {
	/** Characters of a page's main text. */
	mainTextChars: 2_000_000,
	/** Links of one page. */
	links: 10_000,
	/** Characters of a URL, an anchor or a header value. */
	textChars: 4_000,
	/** Entries of a list the audit only counts or samples (mixed content, unsized images, canonicals). */
	listItems: 500,
	/** JSON-LD blocks, and their characters together. */
	jsonLdBlocks: 200,
	jsonLdChars: 1_000_000,
	/** hreflang alternates. */
	hreflang: 1_000,
	/** Schema types. */
	schemaTypes: 200,
	/** Hops of a redirect chain. */
	chainHops: 20,
	/** Readings in one batch. */
	batchPages: 50,
	/** Sitemap URLs in a plan reading, the characters of each, and sitemap files. */
	sitemapUrls: seoCrawlerLimits.maxSitemapUrls,
	sitemapUrlChars: 2_048,
	sitemapFiles: seoCrawlerLimits.maxSitemapFiles,
	/** Characters of a robots.txt. */
	robotsChars: SEO_ROBOTS_MAX_BYTES,
	/** Console lines of a render, the characters of each, and the failed resources it names. */
	renderConsoleLines: 20,
	renderConsoleChars: 300,
	renderFailures: 50,
	/** Resource check readings in one upload: one hand-out's worth. */
	resourceReadings: seoResourceCheckLimits.checksPerStep
} as const;

/**
 * The bounds of a page's markup facts (`ExtractedPage.markup`). The extractor keeps within them by
 * construction, so a reading never needs cutting there; the wire schema checks them.
 */
export const SEO_MARKUP_LIMITS = {
	/** Entries of a list of tags of one kind (titles, canonicals, viewports, ...). */
	values: 10,
	/** Characters of one value kept. */
	valueChars: 500,
	/** Directives of one robots group. */
	robotsTokens: 50,
	/** Examples of a counted kind, and the characters of each. */
	examples: 5,
	exampleChars: 300,
	/** Images described one by one. */
	images: 40,
	/** Element ids kept for bookmarks, and the characters of each. */
	ids: 300,
	idChars: 100,
	/** Links to another page's fragment. */
	externalBookmarks: 20,
	/** Forms described one by one. */
	forms: 10,
	/** `rel="next"` and `rel="prev"` targets of each. */
	pagination: 5,
	/** Analytics ids. */
	analyticsIds: 10,
	/** Subresource URLs handed to the resource checks, and the characters of each. */
	resources: 300,
	resourceChars: 2_000,
	/** Microdata and RDFa items kept, and their JSON's characters together (the JSON-LD budget's size). */
	structuredItems: 30,
	structuredChars: 16_000,
	/** Prices and ratings the structured data states. */
	markedValues: 20,
	/** Elements the microdata and RDFa reads visit, and how deep an item may nest in another. */
	structuredElements: 100_000,
	structuredDepth: 32,
	/** Characters of one microdata or RDFa text value, and of every value one read takes together. */
	structuredValueChars: 1_000,
	structuredReadChars: 200_000,
	/** Characters of visible text searched for the marked-up prices and ratings. */
	shownTextChars: 1_000_000,
	/** JSON-LD blocks read for prices and ratings, the characters of one block, and of all together. */
	jsonBlocks: 200,
	jsonBlockChars: 1_000_000,
	jsonChars: 1_000_000,
	/** How deep a JSON-LD block may nest, the values one page's walks visit, and the `@id`s indexed. */
	jsonDepth: 64,
	jsonNodes: 100_000,
	jsonIds: 1_000
} as const;

/**
 * How much the project's custom search and extraction patterns may ask for and keep
 * (`./custom-checks`): per project, per pattern and per page, the same on the server and on a
 * member's computer.
 */
export const SEO_CUSTOM_CHECK_LIMITS = {
	/** Patterns per project. */
	checks: 10,
	/** Characters of a pattern id, a pattern, a name and an attribute. */
	idChars: 40,
	patternChars: 300,
	nameChars: 80,
	attributeChars: 60,
	/** Characters of a page's HTML searched. */
	htmlChars: 2_000_000,
	/**
	 * The work one page's patterns may do together, shared out evenly between them: a regular
	 * expression spends its size for every character it reads, a selector one unit per step through the
	 * page's elements. A pattern that spends its share yields no result on that page.
	 */
	pageWork: 30_000_000,
	/** The largest regular expression a pattern may compile to (RE2 program instructions). */
	regexProgram: 500,
	/** Matches counted per pattern and page. */
	matches: 1_000,
	/** Values kept per pattern and page, and the characters of each. */
	values: 10,
	valueChars: 300
} as const;

/**
 * How much the crawl behaviour settings may ask for: the member's own User-Agent, the link depth, the
 * pace of a crawl on a member's computer, its custom JavaScript snippets, and the AI prompts.
 */
export const SEO_CRAWL_OPTION_LIMITS = {
	/** Characters of a member's own User-Agent. */
	userAgentChars: 300,
	/** The deepest link depth a member may set. */
	maxDepth: 100,
	/** The slowest and the fastest pace of a crawl on a member's computer, in requests per second. */
	minRequestsPerSecond: 0.2,
	maxRequestsPerSecond: 5,
	/** Snippets per project, the characters of each, and of a snippet's or a prompt's name. */
	scripts: 5,
	scriptChars: 4_000,
	nameChars: 80,
	/** The characters of a snippet's value kept per page. */
	scriptValueChars: 300,
	/** AI prompts per project, and the characters of each. */
	prompts: 3,
	promptChars: 1_000
} as const;

/** The User-Agent presets a crawl may present itself as, in the order the settings list them. */
export const SEO_CRAWL_USER_AGENT_PRESETS = [
	"own",
	"googlebot_smartphone",
	"googlebot_desktop",
	"bingbot",
	"custom"
] as const satisfies readonly SeoCrawlUserAgentPresetValue[];

/** The robots.txt groups a crawl may obey, in the order the settings list them. */
export const SEO_CRAWL_ROBOTS_GROUPS = [
	"own",
	"googlebot",
	"bingbot"
] as const satisfies readonly SeoCrawlRobotsGroupValue[];

/** What a custom pattern looks for, in the order the settings list them. */
export const SEO_CUSTOM_CHECK_MODES = [
	"contains",
	"absent",
	"extract"
] as const satisfies readonly SeoCustomCheckModeValue[];

/** How a custom pattern is matched, in the order the settings list them. */
export const SEO_CUSTOM_CHECK_MATCHES = [
	"text",
	"regex",
	"css"
] as const satisfies readonly SeoCustomCheckMatchValue[];

/** How much the grammar check (a member's computer only) reads and keeps per page. */
export const SEO_GRAMMAR_LIMITS = {
	/** Characters of text read. */
	textChars: 20_000,
	/** Problems kept. */
	issues: 20,
	/** Characters of a problem's kind, text and suggestion. */
	textKept: 120
} as const;
