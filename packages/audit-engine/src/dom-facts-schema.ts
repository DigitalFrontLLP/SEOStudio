import type { SeoPageA11yFacts, SeoPageDesktopView, SeoPageDomFacts } from "./facts";
import { z } from "zod";

/**
 * THE SHAPE OF WHAT A RENDER MEASURES IN THE PAGE: the in-page probe's facts, the accessibility
 * findings and the desktop render's view, every list and string bounded. One schema for both places
 * that must not trust the input: the render reading what the probe handed back, and the server reading
 * what a member's computer uploads.
 */

/** The bounds of the probe's facts and of the accessibility findings. */
export const SEO_DOM_LIMITS = {
	/** Examples a counted fact keeps. */
	examples: 5,
	/** Characters of one CSS path. */
	selectorChars: 200,
	/** Characters of one URL. */
	urlChars: 2_000,
	/** Images described one by one. */
	images: 40,
	/** Image and font URLs the page asked for while it loaded. */
	transferImages: 150,
	transferFonts: 30,
	/** Accessibility rules a page may fail, and the examples each keeps. */
	violations: 150,
	violationExamples: 3,
	/** Characters of a title, a robots value or a canonical in the desktop view; schema types kept. */
	valueChars: 500,
	schemaTypes: 50
} as const;

const limits = SEO_DOM_LIMITS;

/** A whole, non-negative number. */
const count = z.number().int().min(0).max(1_000_000_000);

/** A CSS path. */
const selector = z.string().max(limits.selectorChars);

/** A URL. */
const url = z.string().max(limits.urlChars);

/** A short list of examples. */
const examples = z.array(selector).max(limits.examples);

/** The probe's facts. */
export const seoDomFactsSchema: z.ZodType<SeoPageDomFacts> = z.object({
	viewport: z.object({ width: count, height: count }),
	contentWidth: count,
	overflowing: examples,
	text: z.object({ chars: count, smallChars: count }),
	tapTargets: z.object({ total: count, small: count, examples }),
	images: z
		.array(z.object({ url, width: count, height: count, top: count.optional() }))
		.max(limits.images),
	offscreenEager: z.object({ count, examples }),
	lcp: z
		.object({
			kind: z.enum(["image", "text", "video"]),
			selector,
			url: url.nullable(),
			lazy: z.boolean(),
			fetchPriority: z.string().max(20).nullable()
		})
		.nullable(),
	fadedIn: z.array(url).max(limits.examples).optional(),
	layoutShift: z.object({ score: z.number().min(0).max(1_000), count, sources: examples }),
	dom: z.object({ elements: count, depth: count, width: count }),
	history: z.object({ pushed: count, repeated: z.boolean() }),
	overlay: z.object({ selector, coverage: z.number().min(0).max(1) }).nullable(),
	fakeLinks: z.object({ count, examples }),
	infiniteScroll: z.object({ grew: z.boolean(), paginated: z.boolean() }).nullable(),
	transfer: z.object({
		bytes: count,
		requests: count,
		images: z.array(url).max(limits.transferImages),
		fonts: z.array(url).max(limits.transferFonts)
	})
});

/** The accessibility findings. */
export const seoA11yFactsSchema: z.ZodType<SeoPageA11yFacts> = z.object({
	rules: z.enum(["seo", "all"]),
	violations: z
		.array(
			z.object({
				id: z.string().max(80),
				count,
				examples: z.array(selector).max(limits.violationExamples)
			})
		)
		.max(limits.violations)
});

/** The desktop render's view of the page. */
export const seoDesktopViewSchema: z.ZodType<SeoPageDesktopView> = z.object({
	outcome: z.enum(["ok", "timeout", "failed"]),
	title: z.string().max(limits.valueChars),
	metaRobots: z.string().max(limits.valueChars),
	canonical: z.string().max(limits.urlChars),
	words: count,
	schemaTypes: z.array(z.string().max(200)).max(limits.schemaTypes)
});
