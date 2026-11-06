import { seoCrawlerLimits } from "./config";
import { z } from "zod";

import {
	customCheckProblem,
	SEO_CUSTOM_CHECK_LIMITS,
	SEO_CUSTOM_CHECK_PROBLEM_MESSAGES
} from "./custom-checks";
import {
	SEO_CRAWL_OPTION_LIMITS,
	SEO_CRAWL_ROBOTS_GROUPS,
	SEO_CRAWL_USER_AGENT_PRESETS,
	SEO_CUSTOM_CHECK_MATCHES,
	SEO_CUSTOM_CHECK_MODES
} from "./reading-limits";
import { allowedHeaderName, allowedHeaderValue } from "./site-access";
import {
	SEO_AUDIT_THRESHOLD_KEYS,
	SEO_AUDIT_THRESHOLD_SPECS,
	thresholdOrderProblem
} from "./thresholds";
import type { SeoAuditThresholdKey } from "./thresholds";
import { SEO_URL_REWRITE_LIMITS, urlRewriteValid } from "./url-rewrite";

/**
 * THE WIRE SHAPE OF A CHANGE TO A PROJECT'S CRAWL SETTINGS, from the page or an agent: every field
 * optional (a field left out keeps its value), every list and string bounded. In a file of its own so
 * the route's validator loads none of the crawler.
 */

/**
 * Where a project's scheduled crawls run: `cloud` on the platform's servers, `own_server` on the
 * members' own server through `seostudio agent`.
 */
export const SEO_CRAWL_RUNNERS = ["cloud", "own_server"] as const;

/** How much a member may put in the settings. */
export const SEO_CRAWL_SETTINGS_LIMITS = {
	/** Patterns in the include list, and in the exclude list. */
	patterns: 50,
	/** Characters of one pattern or parameter name. */
	chars: 300,
	/** Parameter names removed. */
	params: 50,
	/** Saved segments. */
	segments: 20,
	/** Characters of a segment's name. */
	segmentName: 60,
	/** Patterns in one segment. */
	segmentPatterns: 20,
	/** The largest sample per URL pattern. */
	samplePerPattern: 10_000,
	/** Extra request headers. */
	headers: 10,
	/** Characters of a header value, a user name or a password. */
	secretChars: 2_000
} as const;

export {
	SEO_CRAWL_OPTION_LIMITS,
	SEO_CRAWL_ROBOTS_GROUPS,
	SEO_CRAWL_USER_AGENT_PRESETS,
	SEO_CUSTOM_CHECK_MATCHES,
	SEO_CUSTOM_CHECK_MODES
};

/**
 * One custom search or extraction pattern: its expression or selector must compile, an expression
 * must be small enough to run on every page, and an extraction needs one (plain text has nothing to
 * extract). A refusal says why. An entry without an id is given one when saved.
 */
const customCheck = z
	.object({
		id: z
			.string()
			.regex(/^[a-z0-9_-]{1,40}$/u)
			.optional(),
		name: z.string().trim().min(1).max(SEO_CUSTOM_CHECK_LIMITS.nameChars),
		mode: z.enum(SEO_CUSTOM_CHECK_MODES),
		match: z.enum(SEO_CUSTOM_CHECK_MATCHES),
		pattern: z.string().min(1).max(SEO_CUSTOM_CHECK_LIMITS.patternChars),
		attribute: z
			.string()
			.trim()
			.min(1)
			.max(SEO_CUSTOM_CHECK_LIMITS.attributeChars)
			.nullable()
			.optional()
	})
	.strict()
	.superRefine((check, ctx) => {
		const problem = customCheckProblem(check);
		if (problem !== null)
			ctx.addIssue({
				code: "custom",
				message: SEO_CUSTOM_CHECK_PROBLEM_MESSAGES[problem],
				path: ["pattern"],
				params: { problem }
			});
	});

/** An id a saved entry is given (a snippet's, a prompt's). */
const entryId = z
	.string()
	.regex(/^[a-z0-9_-]{1,40}$/u)
	.optional();

/** A name a member gives an entry. */
const entryName = z.string().trim().min(1).max(SEO_CRAWL_OPTION_LIMITS.nameChars);

/** One regular expression URL rewrite: its expression must compile under RE2. */
const urlRewrite = z
	.object({
		pattern: z
			.string()
			.min(1)
			.max(SEO_URL_REWRITE_LIMITS.patternChars)
			.refine(
				urlRewriteValid,
				"Not a valid RE2 regular expression, or too large to run on every URL."
			),
		replace: z.string().max(SEO_URL_REWRITE_LIMITS.replaceChars)
	})
	.strict();

/** One custom JavaScript snippet. */
const customScript = z
	.object({
		id: entryId,
		name: entryName,
		code: z.string().min(1).max(SEO_CRAWL_OPTION_LIMITS.scriptChars)
	})
	.strict();

/** One AI prompt over each page. */
const aiPrompt = z
	.object({
		id: entryId,
		name: entryName,
		prompt: z.string().trim().min(1).max(SEO_CRAWL_OPTION_LIMITS.promptChars)
	})
	.strict();

/** A change to what only a crawl on a member's computer does. */
const desktopPatch = z
	.object({
		requestsPerSecond: z
			.number()
			.min(SEO_CRAWL_OPTION_LIMITS.minRequestsPerSecond)
			.max(SEO_CRAWL_OPTION_LIMITS.maxRequestsPerSecond)
			.nullable(),
		screenshots: z.boolean(),
		storeHtml: z.boolean(),
		grammar: z.boolean(),
		scripts: z.array(customScript).max(SEO_CRAWL_OPTION_LIMITS.scripts)
	})
	.partial()
	.strict();

/** One pattern or parameter name. */
const entry = z.string().trim().min(1).max(SEO_CRAWL_SETTINGS_LIMITS.chars);

/** One saved segment. */
const segment = z
	.object({
		name: z.string().trim().min(1).max(SEO_CRAWL_SETTINGS_LIMITS.segmentName),
		patterns: z.array(entry).min(1).max(SEO_CRAWL_SETTINGS_LIMITS.segmentPatterns)
	})
	.strict();

/** A secret as a member types it: a header value, a user name or a password. */
const secret = z
	.string()
	.max(SEO_CRAWL_SETTINGS_LIMITS.secretChars)
	.refine(allowedHeaderValue, "Line breaks and control characters are not allowed.");

/**
 * A change to how the crawl signs in to the site. `headers` replaces the whole list: a header given
 * with `value: null` keeps the value saved under its name. `basicAuth` replaces the credentials (null
 * removes them); `password: null` keeps the saved password.
 */
export const seoCrawlAccessPatchSchema = z
	.object({
		headers: z
			.array(
				z
					.object({
						name: z
							.string()
							.trim()
							.refine(allowedHeaderName, "Not a header name the crawler may send."),
						value: secret.nullable()
					})
					.strict()
			)
			.max(SEO_CRAWL_SETTINGS_LIMITS.headers),
		basicAuth: z
			.object({
				username: secret.refine((value) => value.trim() !== "" && !value.includes(":"), {
					message: "A user name is needed, without a colon."
				}),
				password: secret.nullable()
			})
			.strict()
			.nullable()
	})
	.partial()
	.strict();

/** A change to how the crawl signs in, as validated. */
export type SeoCrawlAccessPatch = z.infer<typeof seoCrawlAccessPatchSchema>;

/**
 * The audit thresholds a project changes: the whole set (a key left out is back at its default), each
 * within its range, a lower bound under its upper one.
 */
const thresholds = z
	.object(
		Object.fromEntries(
			SEO_AUDIT_THRESHOLD_KEYS.map((key) => {
				const spec = SEO_AUDIT_THRESHOLD_SPECS[key];
				return [key, z.number().finite().min(spec.min).max(spec.max)];
			})
		) as Record<SeoAuditThresholdKey, z.ZodNumber>
	)
	.partial()
	.strict()
	.superRefine((value, ctx) => {
		const pair = thresholdOrderProblem(value);
		if (pair !== null)
			ctx.addIssue({
				code: "custom",
				message: `${pair[0]} must be lower than ${pair[1]}.`,
				path: [pair[0]]
			});
	});

/** A change to the crawl settings. */
export const seoCrawlSettingsPatchSchema = z
	.object({
		include: z.array(entry).max(SEO_CRAWL_SETTINGS_LIMITS.patterns),
		exclude: z.array(entry).max(SEO_CRAWL_SETTINGS_LIMITS.patterns),
		removeParams: z.array(entry).max(SEO_CRAWL_SETTINGS_LIMITS.params),
		removeAllParams: z.boolean(),
		lowercasePaths: z.boolean(),
		robotsGroup: z.enum(SEO_CRAWL_ROBOTS_GROUPS),
		segments: z
			.array(segment)
			.max(SEO_CRAWL_SETTINGS_LIMITS.segments)
			.refine(
				(list) => new Set(list.map((item) => item.name.toLowerCase())).size === list.length,
				"Two segments share a name."
			),
		samplePerPattern: z
			.number()
			.int()
			.min(1)
			.max(SEO_CRAWL_SETTINGS_LIMITS.samplePerPattern)
			.nullable(),
		access: seoCrawlAccessPatchSchema,
		customChecks: z.array(customCheck).max(SEO_CUSTOM_CHECK_LIMITS.checks),
		semanticChecks: z.boolean(),
		userAgentPreset: z.enum(SEO_CRAWL_USER_AGENT_PRESETS),
		customUserAgent: z
			.string()
			.trim()
			.min(1)
			.max(SEO_CRAWL_OPTION_LIMITS.userAgentChars)
			.refine(allowedHeaderValue, "Line breaks and control characters are not allowed.")
			.nullable(),
		urlRewrites: z.array(urlRewrite).max(SEO_URL_REWRITE_LIMITS.rewrites),
		subdomainsInternal: z.boolean(),
		maxDepth: z.number().int().min(1).max(SEO_CRAWL_OPTION_LIMITS.maxDepth).nullable(),
		renderWaitMs: z.number().int().min(0).max(seoCrawlerLimits.renderMaxWaitMs),
		aiPrompts: z.array(aiPrompt).max(SEO_CRAWL_OPTION_LIMITS.prompts),
		thresholds,
		desktop: desktopPatch,
		runner: z.enum(SEO_CRAWL_RUNNERS)
	})
	.partial()
	.strict();

/** A change to the crawl settings, as validated. */
export type SeoCrawlSettingsPatch = z.infer<typeof seoCrawlSettingsPatchSchema>;
