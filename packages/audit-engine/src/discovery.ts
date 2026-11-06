import {
	SEO_BINGBOT_ROBOTS_AGENT,
	SEO_CRAWLER_ROBOTS_AGENT,
	SEO_GOOGLEBOT_ROBOTS_AGENT,
	seoCrawlerLimits,
	seoPresetUserAgent
} from "./config";
import type { SeoCrawlerLimits } from "./config";
import type {
	SeoAiPagePrompt,
	SeoCrawlDesktopSettings,
	SeoCrawlRobotsGroupValue,
	SeoCrawlSegment,
	SeoCrawlSettings,
	SeoCustomCheck,
	SeoCustomScript,
	SeoUrlRewrite
} from "./facts";
import { normalizePageUrl } from "./urls";

import { LinkGraph, linkGraphOf } from "./link-graph";
import { compileRobotsPattern, robotsPatternMatches } from "./robots";
import type { RobotsPattern } from "./robots";
import { SEO_CUSTOM_CHECK_LIMITS } from "./reading-limits";
import { memberPatternText } from "./segments";
import { customThresholdsOf } from "./thresholds";
import {
	SEO_CRAWL_OPTION_LIMITS,
	SEO_CRAWL_ROBOTS_GROUPS,
	SEO_CRAWL_SETTINGS_LIMITS,
	SEO_CRAWL_USER_AGENT_PRESETS,
	SEO_CUSTOM_CHECK_MATCHES,
	SEO_CUSTOM_CHECK_MODES
} from "./settings-schema";
import type { ExtractedPage } from "./types";
import { applyUrlRewrites, compileUrlRewrite, SEO_URL_REWRITE_LIMITS } from "./url-rewrite";
import type { CompiledUrlRewrite } from "./url-rewrite";

export { SEO_CRAWL_ROBOTS_GROUPS, SEO_CRAWL_SETTINGS_LIMITS };

/**
 * How a member's computer reads each page of a run, from the project's crawl settings: the device the
 * page renders as, the extra wait after it settles, and what only a computer does (its pace, the
 * screenshots and HTML it keeps for itself, grammar, custom JavaScript snippets).
 */
export interface SeoLocalCrawlPageOptions extends Omit<SeoCrawlDesktopSettings, "scripts"> {
	device: "mobile" | "desktop";
	renderWaitMs: number;
	/**
	 * The custom JavaScript snippets, handed only to the desktop app of a member who manages the crawl
	 * settings (empty for anyone else); `own` when this member last edited it. The computer runs them
	 * only when its member switched snippets on there, and with a recorded login only its own.
	 */
	scripts: SeoLocalScript[];
}

/** One custom JavaScript snippet as a member's computer receives it. */
export interface SeoLocalScript {
	id: string;
	name: string;
	code: string;
	/** Whether the member running the crawl last edited it. */
	own: boolean;
}

/** What a crawl on a member's computer does by default: the server's pace, nothing kept, no snippet. */
export const SEO_CRAWL_DESKTOP_DEFAULT: SeoCrawlDesktopSettings = {
	requestsPerSecond: null,
	screenshots: false,
	storeHtml: false,
	grammar: false,
	scripts: []
};

/**
 * HOW THE CRAWL FINDS PAGES, as pure rules: the members' crawl settings (which URLs are crawled, how a
 * URL is cleaned before it is keyed, whose robots.txt group is obeyed), the crawl-trap guards, the
 * URLs a page points crawlers at without linking to them, and the click depth of every page from the
 * home page over the link graph.
 *
 * The crawl (the host's, or `./site`) applies them where it commits a reading, so a crawl run on the server and one run
 * on a member's computer discover the same pages. PURE: no database, no network.
 */

/** The settings a project without its own uses. */
export const SEO_CRAWL_SETTINGS_DEFAULT: SeoCrawlSettings = {
	include: [],
	exclude: [],
	removeParams: [],
	removeAllParams: false,
	lowercasePaths: false,
	robotsGroup: "own",
	segments: [],
	samplePerPattern: null,
	customChecks: [],
	semanticChecks: false,
	userAgentPreset: "own",
	customUserAgent: null,
	urlRewrites: [],
	subdomainsInternal: false,
	maxDepth: null,
	renderWaitMs: 0,
	aiPrompts: [],
	thresholds: {},
	desktop: SEO_CRAWL_DESKTOP_DEFAULT,
	runner: "cloud"
};

/**
 * A list of short strings read from stored JSON: strings only, trimmed, empty ones and repeats left
 * out, bounded.
 *
 * @param value - The stored value.
 * @param max - The most entries kept.
 * @returns The list.
 */
function stringList(value: unknown, max: number): string[] {
	if (!Array.isArray(value)) return [];
	const kept: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim().slice(0, SEO_CRAWL_SETTINGS_LIMITS.chars);
		if (trimmed === "" || kept.includes(trimmed)) continue;
		kept.push(trimmed);
		if (kept.length >= max) break;
	}
	return kept;
}

/**
 * A project's crawl settings from what is stored, every field checked: anything missing or malformed
 * reads as its default.
 *
 * @param value - The stored settings, or null.
 * @returns The settings.
 */
export function crawlSettingsOf(value: unknown): SeoCrawlSettings {
	if (typeof value !== "object" || value === null) return SEO_CRAWL_SETTINGS_DEFAULT;
	const record = value as Record<string, unknown>;
	const group = record.robotsGroup;
	return {
		include: stringList(record.include, SEO_CRAWL_SETTINGS_LIMITS.patterns),
		exclude: stringList(record.exclude, SEO_CRAWL_SETTINGS_LIMITS.patterns),
		removeParams: stringList(record.removeParams, SEO_CRAWL_SETTINGS_LIMITS.params),
		removeAllParams: record.removeAllParams === true,
		lowercasePaths: record.lowercasePaths === true,
		robotsGroup: SEO_CRAWL_ROBOTS_GROUPS.find((entry) => entry === group) ?? "own",
		segments: segmentList(record.segments),
		samplePerPattern: sampleSize(record.samplePerPattern),
		customChecks: customChecksOf(record.customChecks),
		semanticChecks: record.semanticChecks === true,
		userAgentPreset:
			SEO_CRAWL_USER_AGENT_PRESETS.find((entry) => entry === record.userAgentPreset) ?? "own",
		customUserAgent:
			typeof record.customUserAgent === "string" && record.customUserAgent.trim() !== ""
				? record.customUserAgent.trim().slice(0, SEO_CRAWL_OPTION_LIMITS.userAgentChars)
				: null,
		urlRewrites: urlRewritesOf(record.urlRewrites),
		subdomainsInternal: record.subdomainsInternal === true,
		maxDepth: boundedInteger(record.maxDepth, 1, SEO_CRAWL_OPTION_LIMITS.maxDepth),
		renderWaitMs: boundedInteger(record.renderWaitMs, 0, seoCrawlerLimits.renderMaxWaitMs) ?? 0,
		aiPrompts: aiPromptsOf(record.aiPrompts),
		thresholds: customThresholdsOf(record.thresholds),
		desktop: desktopSettingsOf(record.desktop),
		runner: record.runner === "own_server" ? "own_server" : "cloud"
	};
}

/**
 * A whole number read from stored JSON, when it lies within bounds.
 *
 * @param value - The stored value.
 * @param min - The least kept.
 * @param max - The most kept.
 * @returns The number, or null.
 */
function boundedInteger(value: unknown, min: number, max: number): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null;
	return value < min || value > max ? null : value;
}

/**
 * The URL rewrites read from stored JSON: only those whose expression compiles, bounded.
 *
 * @param value - The stored value.
 * @returns The rewrites.
 */
function urlRewritesOf(value: unknown): SeoUrlRewrite[] {
	if (!Array.isArray(value)) return [];
	const kept: SeoUrlRewrite[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const { pattern, replace } = entry as Record<string, unknown>;
		if (typeof pattern !== "string" || typeof replace !== "string") continue;
		if (compileUrlRewrite({ pattern, replace }) === null) continue;
		kept.push({ pattern, replace });
		if (kept.length >= SEO_URL_REWRITE_LIMITS.rewrites) break;
	}
	return kept;
}

/**
 * Named entries with an id read from stored JSON (snippets, prompts): well-formed ones only, ids
 * unique, each body cut to its bound.
 *
 * @param value - The stored value.
 * @param max - The most entries kept.
 * @param field - The field holding the entry's body.
 * @param bound - The most characters of the body kept.
 * @returns Each entry's id, name and body.
 */
function namedEntries(
	value: unknown,
	max: number,
	field: "code" | "prompt",
	bound: number
): { id: string; name: string; body: string }[] {
	if (!Array.isArray(value)) return [];
	const kept: { id: string; name: string; body: string }[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const { id, name } = record;
		const body = record[field];
		if (typeof id !== "string" || id === "" || kept.some((held) => held.id === id)) continue;
		if (typeof name !== "string" || typeof body !== "string" || body.trim() === "") continue;
		kept.push({
			id,
			name: name.slice(0, SEO_CRAWL_OPTION_LIMITS.nameChars),
			body: body.slice(0, bound)
		});
		if (kept.length >= max) break;
	}
	return kept;
}

/**
 * The AI prompts read from stored JSON.
 *
 * @param value - The stored value.
 * @returns The prompts.
 */
function aiPromptsOf(value: unknown): SeoAiPagePrompt[] {
	return namedEntries(
		value,
		SEO_CRAWL_OPTION_LIMITS.prompts,
		"prompt",
		SEO_CRAWL_OPTION_LIMITS.promptChars
	).map(({ id, name, body }) => ({ id, name, prompt: body }));
}

/**
 * The custom JavaScript snippets read from stored JSON.
 *
 * @param value - The stored value.
 * @returns The snippets.
 */
function customScriptsOf(value: unknown): SeoCustomScript[] {
	const stored = Array.isArray(value) ? value : [];
	const text = (entry: unknown, field: string, max: number): string | null => {
		if (typeof entry !== "object" || entry === null) return null;
		const held = (entry as Record<string, unknown>)[field];
		return typeof held === "string" && held !== "" ? held.slice(0, max) : null;
	};
	return namedEntries(
		value,
		SEO_CRAWL_OPTION_LIMITS.scripts,
		"code",
		SEO_CRAWL_OPTION_LIMITS.scriptChars
	).map(({ id, name, body }) => {
		const entry: unknown = stored.find(
			(item: unknown) =>
				typeof item === "object" && item !== null && (item as Record<string, unknown>).id === id
		);
		return {
			id,
			name,
			code: body,
			editedBy: text(entry, "editedBy", 100),
			editedByName: text(entry, "editedByName", SEO_CRAWL_OPTION_LIMITS.nameChars),
			editedAt: text(entry, "editedAt", 40)
		};
	});
}

/**
 * What a crawl on a member's computer does, read from stored JSON.
 *
 * @param value - The stored value.
 * @returns The settings.
 */
function desktopSettingsOf(value: unknown): SeoCrawlDesktopSettings {
	if (typeof value !== "object" || value === null) return SEO_CRAWL_DESKTOP_DEFAULT;
	const record = value as Record<string, unknown>;
	const speed = record.requestsPerSecond;
	return {
		requestsPerSecond:
			typeof speed === "number" &&
			speed >= SEO_CRAWL_OPTION_LIMITS.minRequestsPerSecond &&
			speed <= SEO_CRAWL_OPTION_LIMITS.maxRequestsPerSecond
				? speed
				: null,
		screenshots: record.screenshots === true,
		storeHtml: record.storeHtml === true,
		grammar: record.grammar === true,
		scripts: customScriptsOf(record.scripts)
	};
}

/**
 * The custom patterns read from stored JSON: well-formed entries only, ids unique, bounded.
 *
 * @param value - The stored value.
 * @returns The patterns.
 */
function customChecksOf(value: unknown): SeoCustomCheck[] {
	if (!Array.isArray(value)) return [];
	const kept: SeoCustomCheck[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const { id, name, pattern, attribute } = record;
		const mode = SEO_CUSTOM_CHECK_MODES.find((option) => option === record.mode);
		const match = SEO_CUSTOM_CHECK_MATCHES.find((option) => option === record.match);
		if (
			typeof id !== "string" ||
			id === "" ||
			typeof name !== "string" ||
			typeof pattern !== "string" ||
			pattern === "" ||
			mode === undefined ||
			match === undefined ||
			kept.some((check) => check.id === id)
		) {
			continue;
		}
		kept.push({
			id,
			name: name.slice(0, SEO_CUSTOM_CHECK_LIMITS.nameChars),
			mode,
			match,
			pattern: pattern.slice(0, SEO_CUSTOM_CHECK_LIMITS.patternChars),
			attribute:
				typeof attribute === "string" && attribute !== ""
					? attribute.slice(0, SEO_CUSTOM_CHECK_LIMITS.attributeChars)
					: null
		});
		if (kept.length >= SEO_CUSTOM_CHECK_LIMITS.checks) break;
	}
	return kept;
}

/**
 * The saved segments read from stored JSON: each with a name and at least one pattern, names unique
 * without regard to case, bounded.
 *
 * @param value - The stored value.
 * @returns The segments.
 */
function segmentList(value: unknown): SeoCrawlSegment[] {
	if (!Array.isArray(value)) return [];
	const kept: SeoCrawlSegment[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const item = entry as Record<string, unknown>;
		const name =
			typeof item.name === "string"
				? item.name.trim().slice(0, SEO_CRAWL_SETTINGS_LIMITS.segmentName)
				: "";
		const patterns = stringList(item.patterns, SEO_CRAWL_SETTINGS_LIMITS.segmentPatterns);
		if (name === "" || patterns.length === 0) continue;
		if (kept.some((held) => held.name.toLowerCase() === name.toLowerCase())) continue;
		kept.push({ name, patterns });
		if (kept.length >= SEO_CRAWL_SETTINGS_LIMITS.segments) break;
	}
	return kept;
}

/**
 * The sample size per URL pattern read from stored JSON.
 *
 * @param value - The stored value.
 * @returns A whole number in bounds, or null for no sampling.
 */
function sampleSize(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null;
	if (value < 1 || value > SEO_CRAWL_SETTINGS_LIMITS.samplePerPattern) return null;
	return value;
}

/**
 * The robots.txt group a crawl obeys: the one the settings choose, but a search engine's group only on
 * a site the project verified it owns. Anywhere else the crawler's own group (then `*`) is obeyed, so a
 * setting can never let the crawler past rules a site owner wrote for it - on the platform's servers
 * and on a member's computer alike: what a computer reads is stored on the platform, so a User-Agent
 * preset there changes the header it sends, never which rules of a site nobody verified it obeys.
 *
 * @param settings - The project's crawl settings.
 * @param verified - Whether the project holds a verified property for its own site.
 * @returns The robots.txt product token obeyed.
 */
export function robotsAgentOf(settings: SeoCrawlSettings, verified: boolean): string {
	if (!verified) return SEO_CRAWLER_ROBOTS_AGENT;
	switch (robotsGroupOf(settings)) {
		case "googlebot":
			return SEO_GOOGLEBOT_ROBOTS_AGENT;
		case "bingbot":
			return SEO_BINGBOT_ROBOTS_AGENT;
		default:
			return SEO_CRAWLER_ROBOTS_AGENT;
	}
}

/**
 * The robots.txt group a search engine User-Agent preset stands for, or null for the crawler's own
 * and a member's own string.
 *
 * @param settings - The project's crawl settings.
 * @returns The group, or null.
 */
function presetRobotsGroup(settings: SeoCrawlSettings): SeoCrawlRobotsGroupValue | null {
	switch (settings.userAgentPreset) {
		case "googlebot_smartphone":
		case "googlebot_desktop":
			return "googlebot";
		case "bingbot":
			return "bingbot";
		default:
			return null;
	}
}

/**
 * The robots.txt group the settings choose: a search engine preset's own group (the crawl obeys the
 * rules written for the crawler it presents itself as), else the group the members picked.
 *
 * @param settings - The project's crawl settings.
 * @returns The group.
 */
export function robotsGroupOf(settings: SeoCrawlSettings): SeoCrawlRobotsGroupValue {
	return presetRobotsGroup(settings) ?? settings.robotsGroup;
}

/**
 * The HTTP User-Agent a crawl sends. A crawl on a member's computer sends the preset (or the member's
 * own string) exactly as asked, under the robots.txt group of the crawler it presents itself as: the
 * member crawls from their own machine. The platform's servers ALWAYS send the crawler's own honest
 * User-Agent, so a site owner can always tell them apart from a search engine and allow or block them:
 * there a preset only changes the viewport and, on a verified site, the robots.txt group obeyed
 * (`robotsAgentOf`).
 *
 * @param settings - The project's crawl settings.
 * @param honest - The crawler's own User-Agent.
 * @param runtime - Where the crawl runs.
 * @returns The User-Agent.
 */
export function requestUserAgentOf(
	settings: SeoCrawlSettings,
	honest: string,
	runtime: "server" | "desktop"
): string {
	if (runtime === "server") return honest;
	switch (settings.userAgentPreset) {
		case "googlebot_smartphone":
		case "googlebot_desktop":
		case "bingbot":
			return seoPresetUserAgent(settings.userAgentPreset);
		case "custom":
			return settings.customUserAgent ?? honest;
		default:
			return honest;
	}
}

/**
 * How a member's computer reads each page, from the project's settings: the custom JavaScript
 * snippets only for a member who manages the crawl settings, each marked when that member last
 * edited it.
 *
 * @param settings - The project's crawl settings.
 * @param userId - The member running the crawl.
 * @param scriptsAllowed - Whether that member's desktop app may receive the snippets.
 * @returns The options.
 */
export function localPageOptions(
	settings: SeoCrawlSettings,
	userId: string,
	scriptsAllowed: boolean
): SeoLocalCrawlPageOptions {
	const { scripts, ...desktop } = settings.desktop;
	return {
		...desktop,
		device: renderDeviceOf(settings),
		renderWaitMs: settings.renderWaitMs,
		scripts: scriptsAllowed
			? scripts.map((script) => ({
					id: script.id,
					name: script.name,
					code: script.code,
					own: script.editedBy === userId
				}))
			: []
	};
}

/**
 * The device a page is rendered as: a desktop for Google's desktop crawler preset, else a phone (as
 * Google's smartphone crawler renders).
 *
 * @param settings - The project's crawl settings.
 * @returns The device.
 */
export function renderDeviceOf(settings: SeoCrawlSettings): "mobile" | "desktop" {
	return settings.userAgentPreset === "googlebot_desktop" ? "desktop" : "mobile";
}

/** A project's URL rules, compiled once per crawl step. */
export interface SeoUrlRules {
	include: RobotsPattern[];
	exclude: RobotsPattern[];
	/** Parameter names removed exactly, lowercased. */
	removeExact: ReadonlySet<string>;
	/** Parameter name prefixes removed, lowercased. */
	removePrefixes: readonly string[];
	removeAllParams: boolean;
	lowercasePaths: boolean;
	/** The members' regular expression rewrites, compiled, applied first. */
	rewrites: readonly CompiledUrlRewrite[];
}

/**
 * A member's pattern, compiled: one that starts with neither `/` nor `*` matches anywhere in the path
 * and query, as if it started with `*`.
 *
 * @param pattern - The pattern as written.
 * @returns The compiled pattern.
 */
function memberPattern(pattern: string): RobotsPattern {
	return compileRobotsPattern(memberPatternText(pattern));
}

/**
 * Compiles a project's URL rules.
 *
 * @param settings - The crawl settings.
 * @returns The rules.
 */
export function compileUrlRules(settings: SeoCrawlSettings): SeoUrlRules {
	const names = settings.removeParams.map((name) => name.toLowerCase());
	return {
		include: settings.include.map(memberPattern),
		exclude: settings.exclude.map(memberPattern),
		removeExact: new Set(names.filter((name) => !name.endsWith("*"))),
		removePrefixes: names.filter((name) => name.endsWith("*")).map((name) => name.slice(0, -1)),
		removeAllParams: settings.removeAllParams,
		lowercasePaths: settings.lowercasePaths,
		rewrites: settings.urlRewrites
			.map(compileUrlRewrite)
			.filter((rewrite): rewrite is CompiledUrlRewrite => rewrite !== null)
	};
}

/**
 * A URL rewritten by the project's rules: the members' regular expression rewrites first, then named
 * (or all) query parameters dropped and the path lowercased. A URL that is not http(s) comes back as it
 * was.
 *
 * @param input - The absolute URL.
 * @param rules - The project's rules.
 * @returns The rewritten URL.
 */
export function rewriteUrl(input: string, rules: SeoUrlRules): string {
	const url =
		rules.rewrites.length === 0 || !/^https?:/iu.test(input)
			? input
			: applyUrlRewrites(input, rules.rewrites);
	if (
		!rules.removeAllParams &&
		!rules.lowercasePaths &&
		rules.removeExact.size === 0 &&
		rules.removePrefixes.length === 0
	) {
		return url;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
	if (rules.lowercasePaths) parsed.pathname = parsed.pathname.toLowerCase();
	if (rules.removeAllParams) {
		parsed.search = "";
	} else {
		for (const name of [...new Set(parsed.searchParams.keys())]) {
			const lower = name.toLowerCase();
			if (
				rules.removeExact.has(lower) ||
				rules.removePrefixes.some((prefix) => lower.startsWith(prefix))
			) {
				parsed.searchParams.delete(name);
			}
		}
	}
	return parsed.href;
}

/**
 * The key a URL found by the crawl is stored under: rewritten by the project's rules, then normalized.
 * A URL carrying a user name or a password has none: it is never crawled.
 *
 * @param url - The absolute URL.
 * @param rules - The project's rules.
 * @returns The page key, or null when the URL names no http(s) page.
 */
export function crawlKeyOf(url: string, rules: SeoUrlRules): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.username !== "" || parsed.password !== "") return null;
	} catch {
		return null;
	}
	return normalizePageUrl(rewriteUrl(url, rules));
}

/**
 * A key's path and query, as the patterns read it.
 *
 * @param key - The page key.
 * @returns The path and query.
 */
function pathOfKey(key: string): string {
	const slash = key.indexOf("/");
	return slash === -1 ? "/" : key.slice(slash);
}

/**
 * Whether the project's include and exclude patterns let the crawl fetch a page.
 *
 * @param key - The page key.
 * @param rules - The project's rules.
 * @returns Whether it is in scope.
 */
export function urlInScope(key: string, rules: SeoUrlRules): boolean {
	const target = pathOfKey(key);
	if (rules.exclude.some((pattern) => robotsPatternMatches(pattern, target))) return false;
	return (
		rules.include.length === 0 ||
		rules.include.some((pattern) => robotsPatternMatches(pattern, target))
	);
}

/** Why a URL reads as a crawl trap. */
export type SeoCrawlTrapValue = "query_params" | "path_depth" | "url_length" | "repeated_path";

/**
 * Whether a URL reads as a crawl trap - too many query parameters, folders nested too deep, too long,
 * or one folder repeating - and which guard it trips.
 *
 * @param key - The page key.
 * @param guards - The guards (the shipped ones by default).
 * @returns The guard it trips, or null when it is fine.
 */
export function crawlTrapOf(
	key: string,
	guards: SeoCrawlerLimits["trapGuards"] = seoCrawlerLimits.trapGuards
): SeoCrawlTrapValue | null {
	if (key.length > guards.maxUrlChars) return "url_length";
	const target = pathOfKey(key);
	const question = target.indexOf("?");
	const path = question === -1 ? target : target.slice(0, question);
	const query = question === -1 ? "" : target.slice(question + 1);
	if (query !== "" && query.split("&").length > guards.maxQueryParams) return "query_params";
	const segments = path.split("/").filter((segment) => segment !== "");
	if (segments.length > guards.maxPathSegments) return "path_depth";
	const seen = new Map<string, number>();
	for (const segment of segments) {
		const count = (seen.get(segment) ?? 0) + 1;
		if (count > guards.maxSegmentRepeats) return "repeated_path";
		seen.set(segment, count);
	}
	return null;
}

/** A path segment or query value that signs the visitor out. */
const SIGN_OUT = /^(?:log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off)(?:\.[a-z0-9]{1,5})?$/i;

/**
 * Whether a link signs the visitor out (`/logout`, `/account/sign-out.php`, `?action=logout`). The
 * crawl never follows one: a crawl that signs in to the site (saved headers or cookies, a recorded
 * login) would end its own session there and read the rest of the site signed out, and the page has
 * nothing to audit. A page that is only about signing out (`/help/how-to-log-out`) is followed.
 *
 * @param key - The page key.
 * @returns Whether it is a sign-out link.
 */
export function isSignOutUrl(key: string): boolean {
	const target = pathOfKey(key);
	const question = target.indexOf("?");
	const path = question === -1 ? target : target.slice(0, question);
	const query = question === -1 ? "" : target.slice(question + 1);
	if (path.split("/").some((segment) => SIGN_OUT.test(segment))) return true;
	return query.split("&").some((pair) => {
		const equals = pair.indexOf("=");
		const name = equals === -1 ? pair : pair.slice(0, equals);
		const value = equals === -1 ? "" : pair.slice(equals + 1);
		return SIGN_OUT.test(name) || SIGN_OUT.test(value);
	});
}

/**
 * The targets of a `Link` header (RFC 8288) a crawler is pointed at: `canonical`, `next`, `prev` and
 * an `alternate` with an `hreflang`, absolute.
 *
 * @param link - The raw header, or null.
 * @param base - The URL the response answered for.
 * @returns The targets.
 */
export function linkHeaderReferences(link: string | null, base: string): string[] {
	if (link === null) return [];
	const found: string[] = [];
	for (const match of link.matchAll(/<([^<>]*)>\s*((?:;[^;,]*)*)/g)) {
		const params = match[2] ?? "";
		const rels = (/;\s*rel\s*=\s*"?([^";,]*)"?/i.exec(params)?.[1] ?? "")
			.toLowerCase()
			.split(/\s+/);
		const hreflang = /;\s*hreflang\s*=/i.test(params);
		const wanted =
			rels.includes("canonical") ||
			rels.includes("next") ||
			rels.includes("prev") ||
			rels.includes("previous") ||
			(rels.includes("alternate") && hreflang);
		if (!wanted) continue;
		try {
			found.push(new URL((match[1] ?? "").trim(), base).href);
		} catch {
			continue;
		}
	}
	return found;
}

/**
 * A URL resolved against a base, its fragment dropped, when it is http(s).
 *
 * @param url - The URL as written.
 * @param base - The URL it is resolved against.
 * @returns The absolute URL, or null.
 */
function absoluteHttpUrl(url: string, base: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url.trim(), base);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	parsed.hash = "";
	return parsed.href;
}

/**
 * Every URL a page points crawlers at without (necessarily) linking to it: its canonicals, its
 * hreflang alternates, `rel="next"` and `rel="prev"`, its AMP version, and the same named in its
 * `Link` header. The crawl fetches them all, as search engines do, so their checks never wait for a
 * link.
 *
 * @param page - The page as read.
 * @param linkHeader - The response's raw `Link` header, or null.
 * @param base - The URL the page answered at.
 * @returns The absolute URLs, each once.
 */
export function pageReferences(
	page: ExtractedPage,
	linkHeader: string | null,
	base: string
): string[] {
	const urls = new Set<string>();
	const add = (url: string): void => {
		const absolute = absoluteHttpUrl(url, base);
		if (absolute !== null) urls.add(absolute);
	};
	for (const url of page.audit.canonicals) add(url);
	if (page.canonical !== "") add(page.canonical);
	for (const entry of page.hreflang) add(entry.url);
	const markup = page.markup;
	if (markup !== undefined) {
		for (const url of [...markup.pagination.next, ...markup.pagination.prev]) add(url);
		if (markup.amp.amphtml !== null) add(markup.amp.amphtml);
	}
	for (const url of linkHeaderReferences(linkHeader, base)) add(url);
	return [...urls];
}

/** One internal link as the click depth reads it. */
export interface SeoDepthLink {
	sourceKey: string;
	targetKey: string;
	nofollow: boolean;
}

/**
 * Every page's CLICK DEPTH: the fewest followed links from the home page (breadth first), each link's
 * target taken where it lands after known redirects and variants (the URL the link spells, when it
 * redirects, sits at the same depth as the page it lands on). A nofollow link is not a path; a page no
 * followed path reaches is left out.
 *
 * @param homeKeys - The home page's keys (its own, and where it redirects).
 * @param links - The internal links.
 * @param resolve - The page a key lands on after known redirects and variants.
 * @returns Page key to its click depth.
 */
export function clickDepths(
	homeKeys: readonly string[],
	links: LinkGraph | readonly SeoDepthLink[],
	resolve: (key: string) => string = (key) => key
): Map<string, number> {
	const graph = links instanceof LinkGraph ? links : linkGraphOf(links, resolve);
	const keys = graph.keyCount;
	const start = new Int32Array(keys + 1);
	const followed = (link: number): boolean =>
		!graph.nofollow(link) &&
		graph.landing(graph.sourceOf(link)) !== graph.landing(graph.targetOf(link));
	for (let link = 0; link < graph.length; link += 1) {
		if (!followed(link)) continue;
		const source = graph.landing(graph.sourceOf(link));
		start[source + 1] = (start[source + 1] ?? 0) + 1;
	}
	for (let key = 0; key < keys; key += 1)
		start[key + 1] = (start[key + 1] ?? 0) + (start[key] ?? 0);
	const fill = start.slice(0, keys);
	const out = new Int32Array(start[keys] ?? 0);
	for (let link = 0; link < graph.length; link += 1) {
		if (!followed(link)) continue;
		const source = graph.landing(graph.sourceOf(link));
		const at = fill[source] ?? 0;
		out[at] = link;
		fill[source] = at + 1;
	}
	const depth = new Int32Array(keys).fill(-1);
	const depths = new Map<string, number>();
	let frontier: number[] = [];
	for (const key of homeKeys) {
		for (const own of new Set([key, resolve(key)])) {
			if (depths.has(own)) continue;
			depths.set(own, 0);
			const id = graph.idOf(own);
			if (id === undefined) continue;
			depth[id] = 0;
			frontier.push(id);
		}
	}
	let level = 0;
	while (frontier.length > 0) {
		level += 1;
		const next: number[] = [];
		for (const id of frontier) {
			for (let at = start[id] ?? 0; at < (start[id + 1] ?? 0); at += 1) {
				const link = out[at] ?? 0;
				const spelled = graph.targetOf(link);
				const target = graph.landing(spelled);
				if (depth[target] === -1) {
					depth[target] = level;
					next.push(target);
				}
				if (depth[spelled] === -1) depth[spelled] = level;
			}
		}
		frontier = next;
	}
	for (let id = 0; id < keys; id += 1) {
		const value = depth[id] ?? -1;
		const key = graph.keys[id] ?? "";
		if (value !== -1 && !depths.has(key)) depths.set(key, value);
	}
	return depths;
}

/** One known page as the link graph's coverage reads it. */
export interface SeoCoveragePage {
	pageKey: string;
	/** Whether the crawl read it. */
	read: boolean;
	/** Whether robots.txt keeps the crawler (and search engines) from it, so it is never read. */
	blocked: boolean;
}

/**
 * HOW MUCH OF THE LINK GRAPH THE CRAWL HAS READ, for the audit rules that judge what is absent from it
 * (no link, a single link, a page deeper than the cut). The graph is complete when every page the crawl
 * knows of was read and the crawl stopped short of its page cap. Every click depth is exact up to the
 * shallowest page not read yet: a shorter path to a page can only run through a page no one read. Past
 * the cap, a link's target the crawl never added counts as unread too.
 *
 * @param pages - Every page the crawl knows of.
 * @param depths - Every key's click depth from the home page ({@link clickDepths}).
 * @param capped - Whether the crawl reached its page cap (targets past it were never added).
 * @returns Whether the graph is complete, and the click depth of the shallowest unread page (null
 *   when no unread page is reachable).
 */
export function linkGraphCoverage(
	pages: readonly SeoCoveragePage[],
	depths: ReadonlyMap<string, number>,
	capped: boolean
): { complete: boolean; shallowestUnread: number | null } {
	const known = new Set(pages.map((page) => page.pageKey));
	const unread = pages.filter((page) => !page.read && !page.blocked).map((page) => page.pageKey);
	const candidates = capped
		? [...unread, ...[...depths.keys()].filter((key) => !known.has(key))]
		: unread;
	let shallowest: number | null = null;
	for (const key of candidates) {
		const depth = depths.get(key);
		if (depth !== undefined && (shallowest === null || depth < shallowest)) shallowest = depth;
	}
	return { complete: unread.length === 0 && !capped, shallowestUnread: shallowest };
}
