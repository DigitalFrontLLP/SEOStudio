import type { SeoPageDomFacts, SeoPageRenderFacts } from "../facts";
import { normalizePageUrl } from "../urls";

import { isSeoAuditRuleId } from "../catalog";
import { directivesNoindex } from "../robots";
import {
	AUDIT_EXAMPLES,
	finding,
	h1MissingOf,
	htmlSnapshot,
	indexableSnapshot
} from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditSnapshot } from "./types";

/**
 * THE RULES OVER THE RENDERED PAGE'S LAYOUT: what the in-page probe measured on the phone render
 * (`facts.render.dom`), what the accessibility checks found (`facts.render.a11y`) and the desktop
 * app's second, desktop render (`facts.render.desktop`). Pure; the same for a cloud and a desktop audit.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - the mobile checks judge only pages with a viewport tag (without one the page is laid out for a
 *   desktop and `viewport_missing` says so) and only pages search engines are asked to show;
 * - content is too wide only past a few pixels of rounding (an error once it is half again as wide as
 *   the screen: the page is laid out for a desktop), small text only when most of a page with
 *   real text is under 12 px, and a small tap target only when another target sits within its 24 px
 *   circle (a link inside a sentence is exempt, as WCAG 2.5.8 exempts it), filed only when at least 3
 *   targets and 10% of the page's are small (one cramped icon row is not a page hard to tap);
 * - an overlay counts only when it is fixed over most of the first screen, holds less than half of
 *   the page's text, and is not a consent or age notice (a legal duty, which Google exempts); a
 *   sticky element sits in the page's own flow on the first screen (a hero, a header), never over it;
 * - the Back button is trapped only when a history entry the page added repeats the one before it, or
 *   the page added three or more entries while it loaded with nobody touching it;
 * - the render answers images with an empty placeholder, so the layout above an image may sit higher or
 *   lower than with the real files: an eager image counts as off the first screen only from two
 *   screens down (browsers load images near the screen early anyway), and one with no size of its own
 *   (the default 300 px width, or the placeholder's 16:9 shape without width and height attributes,
 *   unless the page stretched it across its box) is never measured;
 * - infinite scroll counts only when two scrolls to the bottom both loaded more content (a widget that
 *   loads once is not a feed) and the page offers no next page at a URL of its own;
 * - the parity check compares the two renders of the same HTML, so it flags only what scripts change
 *   by device, and text only when the phone shows less than 70% of the desktop's words.
 */

/** The thresholds of these rules. */
export const RENDERED_DOM_THRESHOLDS = {
	/** Pixels of rounding a content width may exceed the viewport by. */
	widthTolerancePx: 4,
	/**
	 * The content width, as a multiple of the screen's, from which the page is laid out for a desktop
	 * rather than a phone: most of it sits off the screen, which is an error, not a margin to tidy.
	 */
	severeWidthRatio: 1.5,
	/** Visible characters from which a page's text sizes are judged. */
	smallTextMinChars: 200,
	/** The share of the text under 12 px from which it is "most of the page". */
	smallTextShare: 0.5,
	/**
	 * Small tap targets count only when they are at least this many and this share of the page's
	 * targets (Lighthouse passed a page with 90% of its targets well sized).
	 */
	tapTargetsMin: 3,
	tapTargetsShare: 0.1,
	/** DOM elements and nesting depth past which the DOM is excessive (Lighthouse's limits). */
	domElements: 1_500,
	domDepth: 32,
	/** History entries a page may add while it loads before it reads as trapping the Back button. */
	historyPushes: 3,
	/** The share of the desktop's words under which the phone render is missing content. */
	parityWordsShare: 0.7,
	/** The fewest words missing on the phone before the parity check counts it. */
	parityWordsMin: 100
} as const;

/**
 * The page's probe facts on a page read from its HTML and rendered, else null.
 *
 * @param page - The page.
 * @returns The render facts and the probe's, or null.
 */
function renderedDom(page: AuditPage): { render: SeoPageRenderFacts; dom: SeoPageDomFacts } | null {
	const render = page.facts?.render;
	if (render == null || render.outcome === "failed" || htmlSnapshot(page) === null) return null;
	const dom = render.dom;
	return dom == null ? null : { render, dom };
}

/**
 * Whether the page has a viewport tag.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns Whether it does.
 */
function hasViewport(page: AuditPage, snapshot: AuditSnapshot): boolean {
	return (page.facts?.page?.viewport ?? snapshot.viewport ?? "").trim() !== "";
}

/**
 * The phone layout findings: content wider than the screen, small text, small tap targets, and an
 * overlay over the content.
 *
 * @param key - The page.
 * @param dom - The probe's facts.
 * @returns The findings.
 */
function mobileFindings(key: string, dom: SeoPageDomFacts): AuditFinding[] {
	const t = RENDERED_DOM_THRESHOLDS;
	const found: AuditFinding[] = [];
	if (dom.contentWidth > dom.viewport.width + t.widthTolerancePx) {
		const severe = dom.contentWidth >= dom.viewport.width * t.severeWidthRatio;
		found.push(
			finding(key, severe ? "content_not_sized_severe" : "content_not_sized", {
				width: dom.contentWidth,
				viewport: dom.viewport.width,
				elements: dom.overflowing.slice(0, AUDIT_EXAMPLES),
				when: dom.overflowing.length === 0 ? "loading" : "settled"
			})
		);
	}
	const { chars, smallChars } = dom.text;
	if (chars >= t.smallTextMinChars && smallChars > chars * t.smallTextShare) {
		found.push(finding(key, "font_too_small", { percent: Math.round((100 * smallChars) / chars) }));
	}
	const targets = dom.tapTargets;
	if (targets.small >= t.tapTargetsMin && targets.small >= targets.total * t.tapTargetsShare) {
		found.push(
			finding(key, "tap_targets_small", {
				count: dom.tapTargets.small,
				total: dom.tapTargets.total,
				elements: dom.tapTargets.examples.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	if (dom.overlay !== null) {
		found.push(
			finding(key, "intrusive_interstitial", {
				percent: Math.round(dom.overlay.coverage * 100),
				elements: [dom.overlay.selector]
			})
		);
	}
	return found;
}

/**
 * The image and weight findings the probe answers alone: eager images below the first screen, the
 * largest image without a high fetch priority, and an excessive DOM.
 *
 * @param key - The page.
 * @param dom - The probe's facts.
 * @returns The findings.
 */
function loadFindings(key: string, dom: SeoPageDomFacts): AuditFinding[] {
	const t = RENDERED_DOM_THRESHOLDS;
	const found: AuditFinding[] = [];
	if (dom.offscreenEager.count > 0) {
		found.push(
			finding(key, "image_offscreen_eager", {
				count: dom.offscreenEager.count,
				urls: dom.offscreenEager.examples.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	const lcp = dom.lcp;
	if (lcp !== null && lcp.kind === "image" && lcp.url !== null && lcp.fetchPriority !== "high") {
		found.push(finding(key, "image_lcp_priority", { urls: [lcp.url] }));
	}
	if (dom.dom.elements > t.domElements || dom.dom.depth > t.domDepth) {
		found.push(
			finding(key, "dom_size_excessive", {
				elements: dom.dom.elements,
				depth: dom.dom.depth,
				width: dom.dom.width
			})
		);
	}
	return found;
}

/**
 * Two values judged the same once whitespace is collapsed.
 *
 * @param left - One value.
 * @param right - The other.
 * @returns Whether they agree.
 */
function sameText(left: string, right: string): boolean {
	return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

/**
 * Two canonicals judged the same page.
 *
 * @param left - One URL.
 * @param right - The other.
 * @returns Whether they name one page.
 */
function sameCanonical(left: string, right: string): boolean {
	if (left === right) return true;
	if (left === "" || right === "") return false;
	return (normalizePageUrl(left) ?? left) === (normalizePageUrl(right) ?? right);
}

/** What the parity check compares. */
type ParityKind = "robots" | "title" | "canonical" | "structured_data" | "content";

/**
 * What differs between the phone render and the desktop render.
 *
 * @param snapshot - The page as stored (the phone render).
 * @param render - The render facts.
 * @returns The differences, by kind.
 */
function parityDifferences(snapshot: AuditSnapshot, render: SeoPageRenderFacts): ParityKind[] {
	const desktop = render.desktop;
	if (desktop == null || desktop.outcome === "failed") return [];
	const t = RENDERED_DOM_THRESHOLDS;
	const differences: ParityKind[] = [];
	const mobileRobots = render.changed.robots?.rendered ?? snapshot.metaRobots ?? "";
	if (directivesNoindex(mobileRobots) !== directivesNoindex(desktop.metaRobots)) {
		differences.push("robots");
	}
	if (!sameText(snapshot.title ?? "", desktop.title)) differences.push("title");
	if (!sameCanonical(snapshot.canonical ?? "", desktop.canonical)) differences.push("canonical");
	const mobileTypes = new Set((snapshot.schemaTypes ?? []).map((type) => type.toLowerCase()));
	if (desktop.schemaTypes.some((type) => !mobileTypes.has(type.toLowerCase()))) {
		differences.push("structured_data");
	}
	const mobileWords = render.renderedWords ?? 0;
	if (
		mobileWords < desktop.words * t.parityWordsShare &&
		desktop.words - mobileWords >= t.parityWordsMin
	) {
		differences.push("content");
	}
	return differences;
}

/**
 * The accessibility findings: one per failed axe rule the catalog files. An empty H1 that `h1_missing`
 * files is left out of the empty heading count.
 *
 * @param key - The page.
 * @param render - The render facts.
 * @param emptyH1s - The empty H1 elements `h1_missing` files on the page.
 * @returns The findings.
 */
function accessibilityFindings(
	key: string,
	render: SeoPageRenderFacts,
	emptyH1s: number
): AuditFinding[] {
	const found: AuditFinding[] = [];
	for (const violation of render.a11y?.violations ?? []) {
		const ruleId = `a11y_${violation.id.replace(/-/g, "_")}`;
		const count = ruleId === "a11y_empty_heading" ? violation.count - emptyH1s : violation.count;
		if (!isSeoAuditRuleId(ruleId) || count <= 0) continue;
		found.push(
			finding(key, ruleId, {
				count,
				elements: violation.examples.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	return found;
}

/**
 * The findings of one page over its rendered layout, its accessibility checks and its desktop render.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function renderedDomFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const read = renderedDom(page);
	const snapshot = htmlSnapshot(page);
	if (snapshot === null) return [];
	const key = page.pageKey;
	const render = page.facts?.render;
	const indexable = indexableSnapshot(page, context);
	const h1 = indexable === null ? null : h1MissingOf(page, indexable);
	const emptyH1s = h1?.missing === true ? h1.empty : 0;
	const found: AuditFinding[] =
		render == null || render.outcome === "failed"
			? []
			: accessibilityFindings(key, render, emptyH1s);
	if (read === null) return found;
	const { dom } = read;
	const t = RENDERED_DOM_THRESHOLDS;
	if (dom.history.repeated || dom.history.pushed >= t.historyPushes) {
		found.push(finding(key, "js_back_button_hijack", { pushed: dom.history.pushed }));
	}
	const differences = parityDifferences(snapshot, read.render);
	if (differences.length > 0) {
		const flags: Record<string, unknown> = {};
		for (const kind of ["robots", "title", "canonical", "structured_data", "content"] as const) {
			flags[kind] = differences.includes(kind) ? "yes" : "no";
		}
		found.push(
			finding(key, "mobile_desktop_parity", {
				...flags,
				mobileWords: read.render.renderedWords ?? 0,
				desktopWords: read.render.desktop?.words ?? 0
			})
		);
	}
	const scroll = dom.infiniteScroll;
	if (scroll !== null && scroll.grew && !scroll.paginated) {
		found.push(finding(key, "infinite_scroll_no_pages"));
	}
	if (indexable === null) return found;
	if (hasViewport(page, indexable)) found.push(...mobileFindings(key, dom));
	found.push(...loadFindings(key, dom));
	return found;
}
