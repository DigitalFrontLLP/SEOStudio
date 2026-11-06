import { z } from "zod";

import { SEO_AUDIT_PLATFORMS } from "./catalog";
import { seoA11yFactsSchema, seoDesktopViewSchema, seoDomFactsSchema } from "./dom-facts-schema";
import type { SeoPageReading, SeoSitePlanReading } from "./reading";
import type { SeoResourceReading } from "./resource-check";
import {
	SEO_CRAWL_OPTION_LIMITS,
	SEO_CUSTOM_CHECK_LIMITS,
	SEO_GRAMMAR_LIMITS,
	SEO_MARKUP_LIMITS,
	SEO_READING_LIMITS
} from "./reading-limits";

/**
 * THE WIRE SHAPE OF A READING MADE ON A MEMBER'S COMPUTER: every field typed and every list and string
 * bounded by {@link SEO_READING_LIMITS}, so an upload is the exact shape the server's own crawl commits
 * - or it is refused before any of it is stored. The desktop app cuts a reading to these bounds before
 * it sends it (`boundReading`), so a real page never meets them.
 */

const limits = SEO_READING_LIMITS;

/** A bounded string. */
const text = z.string().max(limits.textChars);

/** A bounded nullable string. */
const nullableText = text.nullable();

/** A whole, non-negative number. */
const count = z.number().int().min(0).max(1_000_000_000);

/** An HTTP status, or 0 when nothing answered. */
const httpStatus = z.number().int().min(0).max(999);

/** The examples a sitemap file fact names. */
const SITEMAP_FACT_EXAMPLES = 5;

/** A calendar day. */
const isoDay = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.nullable();

const resourceSchema = z.object({
	finalUrl: text,
	status: httpStatus,
	finalStatus: httpStatus,
	chain: z
		.array(z.object({ url: text, status: httpStatus, location: text.optional() }))
		.max(limits.chainHops),
	contentType: nullableText,
	xRobotsTag: nullableText,
	auditHeaders: z.object({
		strictTransportSecurity: nullableText,
		contentSecurityPolicy: nullableText,
		xContentTypeOptions: nullableText,
		xFrameOptions: nullableText,
		referrerPolicy: nullableText,
		link: nullableText,
		contentType: nullableText.optional(),
		contentEncoding: nullableText.optional(),
		cacheControl: nullableText.optional(),
		contentLanguage: nullableText.optional(),
		refresh: nullableText.optional()
	}),
	sizeBytes: count,
	responseMs: count,
	error: z.enum(["timeout", "blocked", "network", "too_many_redirects"]).nullable(),
	retryAfter: nullableText.optional(),
	htmlUnlabelled: z.boolean().optional(),
	htmlCut: z.object({ head: z.boolean(), mainText: z.boolean() }).optional(),
	botAgentRefused: z.boolean().optional()
});

const listOfUrls = z.array(text).max(limits.listItems);

const markup = SEO_MARKUP_LIMITS;

/** A value of the markup. */
const value = z.string().max(markup.valueChars);

/** An example of the markup. */
const example = z.string().max(markup.exampleChars);

/** A counted kind with a few examples. */
const counted = z.object({ count, examples: z.array(example).max(markup.examples) });

/** A text value and where it landed. */
const placed = z.object({ text: value, inHead: z.boolean() });

/** A list of tags of one kind. */
const tags = <Item extends z.ZodType>(item: Item) => z.array(item).max(markup.values);

/** A robots directive group. */
const robotsGroup = z.object({
	agent: value,
	tokens: z.array(value).max(markup.robotsTokens)
});

/** The markup facts of one read, and the subresources it references. */
const markupSchema = z.object({
	head: z.object({
		htmlTags: count,
		headTags: count,
		bodyTags: count,
		contentBeforeHtml: z.boolean(),
		headNotFirst: z.boolean(),
		breaker: z.object({ tag: z.string().max(64), line: count, inNoscript: z.boolean() }).nullable()
	}),
	titles: tags(placed),
	descriptions: tags(placed),
	robots: tags(robotsGroup.extend({ inHead: z.boolean() })),
	canonicals: tags(
		z.object({
			href: value,
			inHead: z.boolean(),
			attributes: z.array(z.string().max(16)).max(4)
		})
	),
	hreflangOutsideHead: count,
	bases: tags(z.object({ href: value.nullable(), inHead: z.boolean() })),
	refresh: tags(
		z.object({
			content: value,
			delaySeconds: z.number().min(0).nullable(),
			url: value.nullable(),
			inHead: z.boolean()
		})
	),
	viewports: tags(
		z.object({
			content: value,
			width: value.nullable(),
			initialScale: value.nullable(),
			minimumScale: value.nullable(),
			maximumScale: value.nullable(),
			userScalable: value.nullable(),
			inHead: z.boolean()
		})
	),
	lang: z.object({ html: value.nullable(), contentLanguage: value.nullable() }),
	openGraph: z.object({
		title: value.nullable(),
		type: value.nullable(),
		image: value.nullable(),
		url: value.nullable(),
		description: value.nullable(),
		siteName: value.nullable()
	}),
	twitter: z.object({
		card: value.nullable(),
		title: value.nullable(),
		description: value.nullable(),
		image: value.nullable(),
		site: value.nullable()
	}),
	badLinks: z
		.array(
			counted.extend({
				kind: z.enum([
					"empty",
					"whitespace",
					"whitespace_query",
					"malformed",
					"javascript",
					"onclick",
					"localhost",
					"file",
					"protocol"
				]),
				anchors: z.array(example).max(markup.examples).optional(),
				inText: count.optional()
			})
		)
		.max(9),
	bookmarks: z.object({
		missing: z.array(z.string().max(markup.idChars)).max(markup.examples),
		missingCount: count,
		external: z
			.array(z.object({ url: example, fragment: z.string().max(markup.idChars) }))
			.max(markup.externalBookmarks),
		ids: z.array(z.string().max(markup.idChars)).max(markup.ids),
		idsTruncated: z.boolean()
	}),
	forms: z
		.array(z.object({ action: value, method: z.string().max(20), password: z.boolean() }))
		.max(markup.forms),
	formCount: count,
	passwordOutsideForm: z.boolean(),
	images: z
		.array(
			z.object({
				src: example,
				alt: z.string().max(200).nullable(),
				altLength: count,
				srcset: z.boolean(),
				sizes: z.boolean(),
				loading: z.string().max(20).nullable(),
				fetchPriority: z.string().max(20).nullable(),
				width: z.string().max(20).nullable(),
				height: z.string().max(20).nullable()
			})
		)
		.max(markup.images),
	imageCount: count,
	pagination: z.object({
		next: z.array(value).max(markup.pagination),
		prev: z.array(value).max(markup.pagination)
	}),
	amp: z.object({ isAmp: z.boolean(), amphtml: value.nullable() }),
	mobileAlternate: z.object({ url: value, media: value }).nullable(),
	analytics: z.object({
		ids: z.array(z.string().max(64)).max(markup.analyticsIds),
		duplicates: z.array(z.string().max(64)).max(markup.analyticsIds)
	}),
	loremIpsum: z.string().max(160).nullable(),
	plugins: z.object({
		object: count,
		embed: count,
		applet: count,
		imageMaps: count,
		legacy: count.optional()
	}),
	ajaxFragmentMeta: z.boolean(),
	protocolRelative: counted,
	structuredItems: z
		.array(
			z.object({
				syntax: z.enum(["microdata", "rdfa"]),
				json: z.string().max(markup.structuredChars)
			})
		)
		.max(markup.structuredItems)
		.optional(),
	markedValues: z
		.array(
			z.object({
				type: z.string().max(markup.idChars),
				property: z.enum(["price", "rating"]),
				values: z.array(z.string().max(32)).max(markup.examples),
				visible: z.boolean()
			})
		)
		.max(markup.markedValues)
		.optional(),
	structuredTruncated: z.boolean().optional(),
	parseCut: z.boolean().optional(),
	skeleton: z
		.string()
		.regex(/^[0-9a-f]{16}$/)
		.nullable()
		.optional(),
	markdownAlternate: value.nullable().optional(),
	platform: z.enum(SEO_AUDIT_PLATFORMS).nullable().optional(),
	commerce: z
		.object({ cartButtons: z.number().int().min(0).max(1_000_000), price: z.boolean() })
		.optional(),
	resources: z
		.array(
			z.object({
				url: z.string().max(markup.resourceChars),
				kind: z.enum(["image", "stylesheet", "script", "font", "icon", "media", "og_image"])
			})
		)
		.max(markup.resources)
});

const pageSchema = z.object({
	title: text,
	metaDescription: text,
	h1: text,
	h1Count: count,
	h1Empty: count.optional(),
	headings: z
		.array(z.object({ level: z.number().int().min(1).max(6), text }))
		.max(limits.listItems),
	canonical: text,
	metaRobots: text,
	lang: text,
	viewport: text,
	schemaTypes: z.array(text).max(limits.schemaTypes),
	hreflang: z.array(z.object({ lang: text, url: text })).max(limits.hreflang),
	hasOpenGraph: z.boolean(),
	hasTwitterCard: z.boolean(),
	images: count,
	imagesMissingAlt: count,
	datePublished: isoDay,
	dateModified: isoDay,
	links: z
		.array(
			z.object({
				href: text,
				anchor: text,
				placement: z.enum(["body", "nav", "footer", "image"]),
				nofollow: z.boolean()
			})
		)
		.max(limits.links),
	mainText: z.string().max(limits.mainTextChars),
	wordCount: count,
	botWall: z.boolean(),
	audit: z.object({
		canonicals: listOfUrls,
		jsonLd: z
			.array(z.string().max(limits.jsonLdChars))
			.max(limits.jsonLdBlocks)
			.refine(
				(blocks) => blocks.reduce((sum, block) => sum + block.length, 0) <= limits.jsonLdChars,
				"JSON-LD over its bound"
			),
		mixedActive: listOfUrls,
		mixedPassive: listOfUrls,
		images: count,
		unsizedImages: listOfUrls,
		lazyHero: z.object({ src: text, method: z.enum(["native", "javascript"]) }).nullable()
	}),
	markup: markupSchema.optional()
});

/** The page as the computer's browser rendered it. */
const renderedSchema = z.object({
	outcome: z.enum(["ok", "timeout", "failed"]),
	error: z.string().max(64).nullable(),
	finalUrl: text,
	renderMs: count,
	page: pageSchema.nullable(),
	consoleErrors: z.array(z.string().max(limits.renderConsoleChars)).max(limits.renderConsoleLines),
	failedResources: z
		.array(
			z.object({
				url: text,
				type: z.enum(["script", "stylesheet", "xhr", "fetch", "other"]),
				reason: z.enum(["robots", "status", "network"]),
				status: httpStatus.nullable()
			})
		)
		.max(limits.renderFailures),
	blockedRequests: count.optional(),
	rateLimitedRequests: count.optional(),
	dom: seoDomFactsSchema.nullable().optional(),
	a11y: seoA11yFactsSchema.nullable().optional(),
	desktop: seoDesktopViewSchema.nullable().optional()
});

/** A word the spelling check did not know. */
const spellingWord = z.string().max(64);

/** What the optional checks found on a page. */
const checksSchema = z.object({
	spelling: z
		.object({
			language: z.string().max(8),
			checked: count,
			text: z.array(z.object({ word: spellingWord, count })).max(20),
			title: z.array(spellingWord).max(10),
			h1: z.array(spellingWord).max(10)
		})
		.nullable()
		.optional(),
	amp: z
		.object({
			errors: z
				.array(
					z.object({
						code: z.string().max(80),
						params: z.array(z.string().max(120)).max(5),
						line: count
					})
				)
				.max(10),
			errorCount: count
		})
		.nullable()
		.optional(),
	custom: z
		.array(
			z.object({
				id: z.string().max(SEO_CUSTOM_CHECK_LIMITS.idChars),
				count,
				values: z
					.array(z.string().max(SEO_CUSTOM_CHECK_LIMITS.valueChars))
					.max(SEO_CUSTOM_CHECK_LIMITS.values)
			})
		)
		.max(SEO_CUSTOM_CHECK_LIMITS.checks)
		.optional(),
	grammar: z
		.object({
			checked: count,
			count,
			issues: z
				.array(
					z.object({
						kind: z.string().max(SEO_GRAMMAR_LIMITS.textKept),
						text: z.string().max(SEO_GRAMMAR_LIMITS.textKept),
						suggestion: z.string().max(SEO_GRAMMAR_LIMITS.textKept).nullable()
					})
				)
				.max(SEO_GRAMMAR_LIMITS.issues)
		})
		.nullable()
		.optional(),
	scripts: z
		.array(
			z.object({
				id: z.string().max(SEO_CUSTOM_CHECK_LIMITS.idChars),
				value: z.string().max(SEO_CRAWL_OPTION_LIMITS.scriptValueChars).nullable(),
				error: z.enum(["timeout", "error"]).nullable()
			})
		)
		.max(SEO_CRAWL_OPTION_LIMITS.scripts)
		.optional()
});

/**
 * One page's reading, as a member's computer sends it. An app from before rendering sends no
 * `rendered`: the page is then stored from its raw HTML and flagged as not rendered.
 */
export const seoPageReadingSchema: z.ZodType<SeoPageReading> = z.object({
	pageKey: text.min(1),
	resource: resourceSchema,
	page: pageSchema.nullable(),
	rendered: renderedSchema.nullable().default(null),
	checks: checksSchema.nullable().optional()
});

/** One batch of readings, and the pages the computer's test robots.txt kept it from. */
export const seoLocalBatchSchema = z.object({
	batch: z.number().int().min(1).max(1_000_000),
	readings: z.array(seoPageReadingSchema).max(limits.batchPages),
	skipped: z
		.array(text.min(1))
		.max(limits.batchPages * 10)
		.optional()
});

/** A list of URLs a member pasted: each a short string, at most a bounded number. */
const pastedUrls = z.array(z.string().trim().max(limits.sitemapUrlChars)).max(2_000);

/** What opening a crawl run on a member's computer may carry: the URLs of a list run. */
export const seoLocalStartSchema = z.object({ list: pastedUrls.optional() }).strict();

/** A list run's URLs, as the page or an agent sends them. */
export const seoListRunSchema = z.object({ urls: pastedUrls.min(1) }).strict();

/** A single page analysis: the URL and, from the desktop app, its reading. */
export const seoInspectSchema = z
	.object({
		url: z.string().trim().min(1).max(limits.sitemapUrlChars),
		reading: seoPageReadingSchema.optional()
	})
	.strict();

/** How the desktop app asks how to read a page for its analysis. */
export const seoInspectReadSchema = z
	.object({ url: z.string().trim().min(1).max(limits.sitemapUrlChars) })
	.strict();

/** The plan's reading, as a member's computer sends it. */
export const seoSitePlanReadingSchema: z.ZodType<SeoSitePlanReading> = z.object({
	robotsTxt: z.string().max(limits.robotsChars).nullable(),
	sitemap: z.object({
		read: z.boolean(),
		urls: z.array(z.string().max(limits.sitemapUrlChars)).max(limits.sitemapUrls),
		files: z
			.array(
				z.object({
					url: text,
					urls: count,
					withLastmod: count,
					distinctLastmod: count,
					source: z.enum(["robots", "index", "declared_index", "guess"]).optional(),
					status: httpStatus.optional(),
					invalid: z.enum(["not_sitemap", "empty", "namespace", "malformed"]).nullable().optional(),
					outOfScope: z
						.object({ count, examples: z.array(text).max(SITEMAP_FACT_EXAMPLES) })
						.optional(),
					lastmodInvalid: z
						.object({ count, examples: z.array(text).max(SITEMAP_FACT_EXAMPLES) })
						.optional(),
					lastmodFuture: count.optional(),
					deprecatedTags: count.optional(),
					extension: z
						.object({ imagesOver: count, videosIncomplete: count, newsStale: count })
						.optional(),
					repeated: count.optional(),
					hreflang: z
						.object({
							urls: count,
							namespaceMissing: z.boolean(),
							incomplete: count,
							examples: z.array(text).max(5)
						})
						.optional()
				})
			)
			.max(limits.sitemapFiles)
	}),
	soft404: z
		.object({
			checkedAt: z.string().max(64),
			url: text,
			status: httpStatus,
			finalStatus: httpStatus,
			landedOn: nullableText,
			noindex: z.boolean().optional()
		})
		.nullable(),
	robotsFetch: z
		.object({
			status: httpStatus.nullable(),
			outcome: z.enum(["ok", "client_error", "server_error", "timeout", "redirect_loop", "failed"])
		})
		.nullable()
		.optional(),
	agentFiles: z
		.object({
			checkedAt: z.string().max(64),
			files: z
				.array(
					z.object({
						path: z.string().max(100),
						status: httpStatus.nullable(),
						outcome: z.enum([
							"absent",
							"ok",
							"server_error",
							"soft_404",
							"no_h1",
							"no_links",
							"invalid_json"
						])
					})
				)
				.max(10),
			markdownNegotiated: z.boolean()
		})
		.nullable()
		.optional()
});

/** A kept response header, cut to 200 characters, or null. */
const headerText = text.transform((value) => value.slice(0, 200)).nullable();

/**
 * One resource check made on a member's computer. Any field it does not name (the `headers` an older
 * desktop app still sends, read from a HEAD alone, among them) is dropped, never stored.
 */
const resourceReadingSchema: z.ZodType<SeoResourceReading> = z.object({
	url: text,
	kind: z.enum([
		"image",
		"stylesheet",
		"script",
		"font",
		"icon",
		"media",
		"og_image",
		"other",
		"link",
		"document",
		"spelling"
	]),
	method: z.enum(["head", "get"]),
	status: httpStatus,
	finalStatus: httpStatus,
	finalUrl: text,
	chain: z.array(z.object({ url: text, status: httpStatus })).max(limits.chainHops),
	contentType: nullableText,
	sizeBytes: count.nullable(),
	width: count.nullable().optional(),
	height: count.nullable().optional(),
	title: z.string().max(300).nullable().optional(),
	delivery: z
		.object({
			cacheControl: headerText,
			expires: headerText,
			contentEncoding: headerText,
			decodedBytes: count.optional(),
			animated: z.boolean().optional()
		})
		.nullable()
		.optional(),
	responseMs: count,
	error: z.enum(["timeout", "blocked", "network", "too_many_redirects", "dns_not_found"]).nullable()
});

/** One upload of resource checks made on a member's computer. */
export const seoLocalResourcesSchema = z.object({
	readings: z.array(resourceReadingSchema).max(limits.resourceReadings)
});
