import { seoCrawlerLimits } from "../config";
import type { SeoPageRenderChange } from "../facts";
import { normalizePageUrl } from "../urls";

import { directivesNofollow, directivesNoindex } from "../robots";
import { bareHostOfKey, hostOfKey } from "../scope";
import { AUDIT_EXAMPLES, finding, htmlSnapshot, onOwnHost } from "./page-state";
import type { AuditFinding, AuditPage } from "./types";

/**
 * THE RENDERING RULES: every page is rendered in a browser as Google renders it, and these compare the
 * rendered page with its raw HTML (`facts.render`, written by the crawl on every read).
 *
 * TUNED TO FLAG ONLY REAL DIFFERENCES:
 * - a field counts as changed only when the two reads disagree once whitespace is collapsed (a
 *   canonical once both are normalized, robots directives in any order), so a server-rendered or
 *   static page - whose rendered DOM says what its HTML said - is never flagged;
 * - a nofollow JavaScript removes is filed only when the raw HTML did not also say noindex (a removed
 *   noindex is filed for that alone); structured data counts as added by JavaScript only for a type
 *   the raw HTML does not state at all;
 * - main content "needs JavaScript" only when the rendered page has real text and the raw HTML holds
 *   at most a quarter of it; on such a page the links, title, description and H1 that only the render
 *   holds are that one fact, never filed again each on its own (a value JavaScript CHANGES still is);
 * - a failed resource is a script or a stylesheet (what rendering depends on); images, fonts and
 *   media are never loaded at all; on a render that ran out of time only a resource the site answered
 *   with an error counts, since a request the render's end cut off proves nothing; another host's
 *   script (a share counter, a chat widget) counts only on a page whose content scripts build, as a
 *   page the server sends whole shows the same content without it;
 * - console errors that only say a data request failed, on a page whose requests robots.txt kept the
 *   crawler from, are those blocked requests again, never filed as script errors;
 * - what robots.txt keeps the crawler from is a problem (`resources_blocked`) only where the page needs
 *   it to render: a stylesheet (the layout changes), or a script on a page whose content scripts build
 *   (the render holds real text and the raw HTML at most a quarter of it). A blocked cart, checkout,
 *   pixel or data request, or a script on a page served whole or nearly empty either way, is an
 *   insight (`resources_blocked_minor`);
 * - a canonical JavaScript changes or removes is a warning, and one it adds only when it names another
 *   page (with none in the raw HTML, a canonical naming the page itself conflicts with nothing); an error (`js_canonical_raw_elsewhere`) when the
 *   raw HTML names another page and the rendered page names the page itself: Google may keep the
 *   HTML's and drop the page;
 * - a page read before rendering, or with no HTML, is not judged; a page whose render failed is
 *   filed for that alone, its other checks judged on the raw HTML by the other families; a render a
 *   script moved to another page is a redirect (`./redirects`), not a failure.
 */

/**
 * A console error that only says a data request failed: on a page whose requests robots.txt kept the
 * crawler from, that is the blocked request again (`resources_blocked`), not a script error.
 */
const FETCH_FAILURE =
	/^(?:Uncaught (?:\(in promise\) )?)?TypeError: (?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)\s*$/i;

/** A script path of a cart, checkout or tracking pixel: never what builds a page's content. */
const CART_OR_PIXEL =
	/(?:^|[/_.-])(?:carts?|checkouts?|basket|bag|wpm|pixels?|analytics|tracking|gtag|gtm)(?=[/_.?-]|$)/i;

/**
 * Whether a blocked request is a script that may build the page's content: a script file that is not
 * a cart, checkout or tracking script.
 *
 * @param url - The blocked request's URL.
 * @returns Whether it is.
 */
function contentScript(url: string): boolean {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return false;
	}
	return /\.m?js$/i.test(path) && !CART_OR_PIXEL.test(path);
}

/** The thresholds of the rendering checks. */
export const RENDERING_THRESHOLDS = {
	/** Rendered main-text words from which a page's content is judged. */
	jsContentMinWords: 50,
	/** The share of the rendered words at or under which the raw HTML lacks the main content. */
	jsContentRawShare: 0.25
} as const;

/**
 * How a field changed: added by JavaScript, removed by it, or changed.
 *
 * @param change - The two values.
 * @returns The kind.
 */
function kindOf(change: SeoPageRenderChange): "added" | "removed" | "changed" {
	if (change.raw === "") return "added";
	if (change.rendered === "") return "removed";
	return "changed";
}

/**
 * A changed field's params: the kind, and both values when present.
 *
 * @param change - The two values.
 * @returns The params.
 */
function changeParams(change: SeoPageRenderChange): Record<string, unknown> {
	return { change: kindOf(change), raw: change.raw, rendered: change.rendered };
}

/**
 * Whether the raw HTML names another page as canonical while the rendered page names the page itself
 * (a client-rendered app whose one `index.html` names the home page on every route): Google may keep
 * the HTML's canonical and fold the page into the other one.
 *
 * @param pageKey - The page.
 * @param change - The canonical in the raw HTML and after JavaScript.
 * @returns Whether it does.
 */
function rawCanonicalElsewhere(pageKey: string, change: SeoPageRenderChange): boolean {
	if (change.raw === "" || change.rendered === "") return false;
	const host = hostOfKey(pageKey);
	const raw = normalizePageUrl(change.raw.trim(), host);
	return (
		raw !== null && raw !== pageKey && normalizePageUrl(change.rendered.trim(), host) === pageKey
	);
}

/**
 * Whether JavaScript only added a canonical naming the page itself: with none in the raw HTML there
 * are no two signals to conflict, and Google picks an injected canonical up when it renders the page.
 *
 * @param pageKey - The page.
 * @param change - The canonical in the raw HTML and after JavaScript.
 * @returns Whether it did.
 */
function addedSelfCanonical(pageKey: string, change: SeoPageRenderChange): boolean {
	if (kindOf(change) !== "added") return false;
	return normalizePageUrl(change.rendered.trim(), hostOfKey(pageKey)) === pageKey;
}

/**
 * The rendering findings of one page.
 *
 * @param page - The page.
 * @returns Its findings.
 */
export function renderingFindings(page: AuditPage): AuditFinding[] {
	const render = page.facts?.render;
	if (render == null || htmlSnapshot(page) === null) return [];
	const key = page.pageKey;
	if (render.outcome === "failed") {
		if (render.error === "navigated") return [];
		return [finding(key, "render_failed", { error: render.error ?? "" })];
	}
	const found: AuditFinding[] = [];
	if (render.outcome === "timeout") {
		found.push(
			finding(key, "render_timeout", {
				seconds: Math.round(seoCrawlerLimits.renderTimeoutMs / 1000)
			})
		);
	}
	const t = RENDERING_THRESHOLDS;
	const words = render.renderedWords ?? 0;
	const built = words >= t.jsContentMinWords && render.rawWords <= words * t.jsContentRawShare;
	if (built) {
		found.push(
			finding(key, "needs_javascript", { rawWords: render.rawWords, renderedWords: words })
		);
	}
	if (render.jsOnlyLinks.count > 0 && !built) {
		found.push(
			finding(key, "js_links_only", {
				count: render.jsOnlyLinks.count,
				pages: render.jsOnlyLinks.examples.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	const changed = render.changed;
	const own = (change: SeoPageRenderChange | undefined): change is SeoPageRenderChange =>
		change !== undefined && !(built && kindOf(change) === "added");
	if (own(changed.title)) found.push(finding(key, "js_title_changed", changeParams(changed.title)));
	if (own(changed.metaDescription))
		found.push(finding(key, "js_meta_description_changed", changeParams(changed.metaDescription)));
	if (own(changed.h1)) found.push(finding(key, "js_h1_changed", changeParams(changed.h1)));
	if (changed.canonical !== undefined && !addedSelfCanonical(key, changed.canonical))
		found.push(
			finding(
				key,
				rawCanonicalElsewhere(key, changed.canonical)
					? "js_canonical_raw_elsewhere"
					: "js_canonical_changed",
				changeParams(changed.canonical)
			)
		);
	if (changed.robots !== undefined) {
		const rawNoindex = directivesNoindex(changed.robots.raw);
		const renderedNoindex = directivesNoindex(changed.robots.rendered);
		if (rawNoindex && !renderedNoindex)
			found.push(finding(key, "js_noindex_removed", { raw: changed.robots.raw }));
		else if (!rawNoindex && renderedNoindex)
			found.push(finding(key, "js_noindex_added", { rendered: changed.robots.rendered }));
		if (
			!rawNoindex &&
			directivesNofollow(changed.robots.raw) &&
			!directivesNofollow(changed.robots.rendered)
		)
			found.push(finding(key, "js_nofollow_removed", { raw: changed.robots.raw }));
	}
	const added = changed.schemaTypesAdded ?? [];
	if (added.length > 0) found.push(finding(key, "js_structured_data_only", { types: added }));
	if (changed.hreflang !== undefined) {
		found.push(
			finding(key, "js_hreflang_changed", {
				rawCount: changed.hreflang.rawCount,
				renderedCount: changed.hreflang.renderedCount
			})
		);
	}
	const errors = render.consoleErrors;
	const onlyBlockedFetches =
		render.blockedResources.count > 0 &&
		errors.examples.length === errors.count &&
		errors.examples.every((message) => FETCH_FAILURE.test(message));
	if (errors.count > 0 && !onlyBlockedFetches) {
		found.push(
			finding(key, "js_errors", {
				count: render.consoleErrors.count,
				messages: render.consoleErrors.examples.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	const blocked = render.blockedResources;
	if (blocked.count > 0) {
		const contentByScript =
			words >= t.jsContentMinWords && render.rawWords <= words * t.jsContentRawShare;
		const needed =
			(blocked.stylesheets ?? 0) > 0 ||
			((blocked.scripts ?? 0) > 0 && contentByScript && blocked.examples.some(contentScript));
		found.push(
			finding(key, needed ? "resources_blocked" : "resources_blocked_minor", {
				count: blocked.count,
				urls: blocked.examples.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	const failed = render.failedResources;
	const siteHost = bareHostOfKey(key);
	const needed = failed.examples.filter(
		(failure) =>
			(render.outcome !== "timeout" || failure.status !== null) &&
			(failure.type !== "script" || built || onOwnHost(failure.url, siteHost))
	);
	const count =
		render.outcome !== "timeout" && needed.length === failed.examples.length
			? failed.count
			: needed.length;
	if (count > 0) {
		found.push(
			finding(key, "resources_failed", {
				count,
				urls: needed.map((failure) => failure.url).slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	return found;
}
