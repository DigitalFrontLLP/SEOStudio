import type { SeoPageFetchModeValue, SeoPageRenderChange, SeoPageRenderFacts } from "./facts";
import { normalizePageUrl } from "./urls";

import type { SeoRenderedReading } from "./reading";
import { directivesNoindex } from "./robots";
import { outsideHead } from "./rules/head";
import { isInternalHost } from "./scope";
import type { SiteScope } from "./scope";
import type { ExtractedPage } from "./types";

/**
 * RAW AGAINST RENDERED: which read of a page the crawl stores, and what the browser's render found
 * beside the raw HTML - the facts the rendering checks judge (`./rules/rendering`). Pure.
 */

/** Examples a fact list keeps. */
const EXAMPLES = 5;

/** Characters of a changed value kept. */
const VALUE_CHARS = 300;

/**
 * A console error the render itself causes: it never loads audio or video, so a page that plays a
 * video reports that the video has no source; it loads no fonts, so a page that loads one from a
 * script (`document.fonts.load`, `new FontFace(...).load()`) reports the bare network error the
 * font's promise rejects with; it offers no service worker (as Google's renderer offers none), so a
 * page that registers one reports that the browser lacks them; and it switches 3D graphics off (both
 * the server's and the desktop app's render), so a page drawing with WebGL reports that it could not
 * start it. A visitor's browser has all four and never sees the error.
 */
const RENDER_CAUSED =
	/NotSupportedError: (?:The element has no supported sources|Failed to load because no supported source was found)|MEDIA_ELEMENT_ERROR|\[object MediaError\]|MEDIA_ERR_SRC_NOT_SUPPORTED|service ?workers?\b|\bWebGL|^(?:Uncaught (?:\(in promise\) )?)?(?:NetworkError: )?A network error occurred\.?$/i;

/**
 * A console error that only reports a request refused with a 403, which, on a page where a host
 * refused the render's requests for its rate limit, is that refusal (`AxiosError: Request failed with
 * status code 403`).
 */
const REFUSED_403 = /\bstatus(?: code| of)? 403\b/i;

/**
 * A console error that only reports the site rate-limiting a request (429 Too Many Requests): the
 * crawl's own pace caused it, reading many pages one after another, which no visitor's browsing does.
 */
const RATE_LIMITED = /\bToo Many Requests\b|\bstatus of 429\b/i;

/**
 * A console error that only says a request failed, with nothing else in it but a logger's label
 * (`Analytics Logger [Error]: Failed to fetch`).
 */
const BARE_FETCH_FAILURE =
	/^(?:[^:\n]{1,60}:\s*)?(?:Uncaught (?:\(in promise\) )?)?(?:TypeError: )?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)\s*$/i;

/**
 * A console error in which a tracker only says it failed to send a page view or an event, with
 * nothing else in it but its label (`TildaStat: fail pageview`).
 */
const TRACKING_FAILURE =
	/^(?:[^:\n]{1,60}:\s*)?(?:fail(?:ed|ure)?|error)(?: to (?:send|track|log|record))?\s+(?:page ?views?|events?|hits?|beacons?|tracking|stats?)\.?\s*$/i;

/** A console error that names a POST and the URL it went to. */
const POST_TO = /\bPOST\s[^\n]*?https?:\/\/([^\s/?#'"]+)/i;

/**
 * A console error that is only an object, with no message of its own: its type (`Object`,
 * `CustomEvent`) or its printed preview (`{status: 0}`, `ProgressEvent {isTrusted: true, …}`), whole or
 * cut short.
 */
const BARE_OBJECT = /^(?:[A-Z][A-Za-z]*|(?:[A-Z][A-Za-z]* )?\{.*)$/;

/**
 * Whether a console error is the render's own refusal again: the render sends a page's POST only to
 * the page's own site (it is never a proxy), so on a page whose render refused requests, a bare
 * "failed to fetch", a tracker's bare "failed to send the page view" ({@link TRACKING_FAILURE}), an
 * error naming a POST to another host, and a bare object a failed request's handler logged (`Object`,
 * `CustomEvent`) are what the refusal caused. A visitor's browser sends those requests and never sees
 * the error.
 *
 * @param message - The console error.
 * @param scope - The site.
 * @returns Whether the refusal caused it.
 */
function refusalCaused(message: string, scope: SiteScope): boolean {
	if (
		BARE_FETCH_FAILURE.test(message) ||
		TRACKING_FAILURE.test(message) ||
		BARE_OBJECT.test(message.trim())
	)
		return true;
	const host = POST_TO.exec(message)?.[1];
	return host !== undefined && !isInternalHost(scope, host.toLowerCase());
}

/** Why a page with HTML has no render: the reading was made by an app from before rendering. */
export const SEO_NOT_RENDERED = "not_rendered";

/**
 * The read of a page the crawl stores and audits: the rendered page whenever the browser rendered it
 * (as Google indexes it), else the raw HTML. One exception, as Google behaves: a `noindex` in the raw
 * HTML stands even when a script removes it, since Google does not render a page its HTML keeps out.
 *
 * @param raw - The raw HTML's read.
 * @param rendered - The render, or null when there was none.
 * @returns The page and the mode its snapshot is stored under.
 */
export function primaryRead(
	raw: ExtractedPage,
	rendered: SeoRenderedReading | null
): { page: ExtractedPage; mode: SeoPageFetchModeValue } {
	const page = rendered === null || rendered.outcome === "failed" ? null : rendered.page;
	if (page === null) return { page: raw, mode: "plain" };
	const keepRawNoindex = directivesNoindex(raw.metaRobots) && !directivesNoindex(page.metaRobots);
	return {
		page: keepRawNoindex ? { ...page, metaRobots: raw.metaRobots } : page,
		mode: "browser"
	};
}

/**
 * The internal pages a read links to.
 *
 * @param scope - The site.
 * @param page - The read.
 * @returns Their keys, and the raw URL of each.
 */
function internalTargets(scope: SiteScope, page: ExtractedPage): Map<string, string> {
	const targets = new Map<string, string>();
	for (const link of page.links) {
		let host: string;
		try {
			host = new URL(link.href).hostname.toLowerCase();
		} catch {
			continue;
		}
		if (!isInternalHost(scope, host)) continue;
		const key = normalizePageUrl(link.href);
		if (key !== null && !targets.has(key)) targets.set(key, link.href);
	}
	return targets;
}

/**
 * A text value as compared: whitespace collapsed.
 *
 * @param value - The value.
 * @returns It, collapsed.
 */
function collapsed(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * The change of one text field, or nothing when the two reads agree.
 *
 * @param raw - What the raw HTML said.
 * @param rendered - What the rendered page says.
 * @param same - How two values are judged equal.
 * @returns The change, or undefined.
 */
function change(
	raw: string,
	rendered: string,
	same: (left: string, right: string) => boolean = (left, right) => left === right
): SeoPageRenderChange | undefined {
	const left = collapsed(raw);
	const right = collapsed(rendered);
	if (same(left, right)) return undefined;
	return { raw: left.slice(0, VALUE_CHARS), rendered: right.slice(0, VALUE_CHARS) };
}

/**
 * Two canonical URLs judged the same page.
 *
 * @param left - One URL.
 * @param right - The other.
 * @returns Whether they name one page.
 */
function sameUrl(left: string, right: string): boolean {
	if (left === right) return true;
	if (left === "" || right === "") return false;
	return (normalizePageUrl(left) ?? left) === (normalizePageUrl(right) ?? right);
}

/**
 * Two robots directives judged the same: the same set of directives, in any order.
 *
 * @param left - One value.
 * @param right - The other.
 * @returns Whether they say the same.
 */
function sameDirectives(left: string, right: string): boolean {
	const set = (value: string): string =>
		[
			...new Set(
				value
					.toLowerCase()
					.split(/[\s,]+/)
					.filter((part) => part !== "")
			)
		]
			.sort()
			.join(",");
	return set(left) === set(right);
}

/**
 * A page's hreflang alternates as sorted `lang url` lines.
 *
 * @param page - The read.
 * @returns The lines.
 */
function hreflangLines(page: ExtractedPage): string[] {
	return [
		...new Set(page.hreflang.map((entry) => `${entry.lang.toLowerCase()} ${collapsed(entry.url)}`))
	].sort();
}

/**
 * WHAT THE RENDER FOUND beside the raw HTML.
 *
 * @param scope - The site.
 * @param raw - The raw HTML's read.
 * @param rendered - The render, or null when the reading carries none (an app from before rendering).
 * @returns The facts the rendering checks judge.
 */
export function renderFactsOf(
	scope: SiteScope,
	raw: ExtractedPage,
	rendered: SeoRenderedReading | null
): SeoPageRenderFacts {
	const rawLinks = internalTargets(scope, raw);
	const page = rendered === null || rendered.outcome === "failed" ? null : rendered.page;
	const resources = rendered?.failedResources ?? [];
	const blocked = resources.filter((failure) => failure.reason === "robots");
	const failed = resources.filter(
		(failure) =>
			failure.reason !== "robots" && (failure.type === "script" || failure.type === "stylesheet")
	);
	const refused = (rendered?.blockedRequests ?? 0) > 0;
	const rateLimited = (rendered?.rateLimitedRequests ?? 0) > 0;
	const consoleErrors = (rendered?.consoleErrors ?? []).filter(
		(message) =>
			!RENDER_CAUSED.test(message) &&
			!RATE_LIMITED.test(message) &&
			!(rateLimited && REFUSED_403.test(message)) &&
			!(refused && refusalCaused(message, scope))
	);
	const facts: SeoPageRenderFacts = {
		outcome: rendered === null ? "failed" : page === null ? "failed" : rendered.outcome,
		error:
			rendered === null ? SEO_NOT_RENDERED : page === null ? (rendered.error ?? "browser") : null,
		renderMs: rendered?.renderMs ?? 0,
		rawWords: raw.wordCount,
		renderedWords: page?.wordCount ?? null,
		rawInternalLinks: rawLinks.size,
		renderedInternalLinks: null,
		jsOnlyLinks: { count: 0, examples: [] },
		changed: {},
		consoleErrors: { count: consoleErrors.length, examples: consoleErrors.slice(0, EXAMPLES) },
		blockedResources: {
			count: blocked.length,
			examples: blocked.slice(0, EXAMPLES).map((failure) => failure.url.slice(0, 500)),
			stylesheets: blocked.filter((failure) => failure.type === "stylesheet").length,
			scripts: blocked.filter((failure) => failure.type === "script").length
		},
		failedResources: {
			count: failed.length,
			examples: failed
				.slice(0, EXAMPLES)
				.map((failure) => ({ ...failure, url: failure.url.slice(0, 500) }))
		},
		rawHead: raw.markup?.head ?? null,
		...(raw.markup == null ? {} : { rawOutsideHead: outsideHead(raw.markup) }),
		...(rendered?.error === "navigated" ? { navigatedTo: rendered.finalUrl.slice(0, 500) } : {})
	};
	if (page === null) return facts;
	if (rendered?.dom != null) facts.dom = rendered.dom;
	if (rendered?.a11y != null) facts.a11y = rendered.a11y;
	if (rendered?.desktop != null) facts.desktop = rendered.desktop;
	const renderedLinks = internalTargets(scope, page);
	const jsOnly = [...renderedLinks.keys()].filter((key) => !rawLinks.has(key)).sort();
	facts.renderedInternalLinks = renderedLinks.size;
	facts.jsOnlyLinks = { count: jsOnly.length, examples: jsOnly.slice(0, EXAMPLES) };
	const changed: SeoPageRenderFacts["changed"] = {};
	const title = change(raw.title, page.title);
	if (title !== undefined) changed.title = title;
	const description = change(raw.metaDescription, page.metaDescription);
	if (description !== undefined) changed.metaDescription = description;
	const h1 = change(raw.h1, page.h1);
	if (h1 !== undefined) changed.h1 = h1;
	const rawTypes = new Set(raw.schemaTypes.map((type) => type.toLowerCase()));
	const added = [...new Set(page.schemaTypes)]
		.filter((type) => !rawTypes.has(type.toLowerCase()))
		.sort()
		.slice(0, EXAMPLES);
	if (added.length > 0) changed.schemaTypesAdded = added;
	const canonical = change(raw.canonical, page.canonical, sameUrl);
	if (canonical !== undefined) changed.canonical = canonical;
	const robots = change(raw.metaRobots, page.metaRobots, sameDirectives);
	if (robots !== undefined) changed.robots = robots;
	const rawHreflang = hreflangLines(raw);
	const renderedHreflang = hreflangLines(page);
	if (rawHreflang.join("\n") !== renderedHreflang.join("\n")) {
		changed.hreflang = {
			raw: rawHreflang.join(", ").slice(0, VALUE_CHARS),
			rendered: renderedHreflang.join(", ").slice(0, VALUE_CHARS),
			rawCount: rawHreflang.length,
			renderedCount: renderedHreflang.length
		};
	}
	facts.changed = changed;
	return facts;
}
