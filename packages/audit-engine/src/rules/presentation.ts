import type { SeoPageViewport } from "../facts";

import { finding, indexableSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";

/**
 * THE MOBILE AND SOCIAL RULES: the viewport tag phones need, a separate mobile site, and the share
 * previews.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS: they judge only pages search engines are asked to show, read from
 * the latest fetch. Missing X (Twitter) card tags are never filed on their own: X reads the Open Graph
 * tags when its own are missing, so a page without either is `open_graph_missing` alone. A viewport
 * tag is invalid only for what changes how a phone lays out or zooms the page: more than one tag, no
 * `width`, a fixed width instead of `device-width`, zooming turned off (`user-scalable=no`, or a
 * `maximum-scale` under 2, the same line the accessibility rules draw), or an `initial-scale` other
 * than 1. Wix's own phone viewport (`width=320` on a page Wix built) is never filed as a fixed width: the
 * platform writes it and its owner cannot change it. A fixed width wider than a phone (500 px or more,
 * `viewport_fixed_width`) is a warning of its own: a phone shows the whole page scaled down, so its text
 * reads at about half its size. A separate mobile site (`rel="alternate" media`) is
 * an insight: it works, but one responsive page is what search engines recommend.
 */

/** The fixed width Wix writes into the viewport tag of every phone page it builds. */
const WIX_PHONE_WIDTH = "320";

/** The fixed viewport width from which a phone shows the page scaled down (wider than a phone). */
const WIDE_FIXED_WIDTH = 500;

/** The `maximum-scale` under which zooming is too limited to read small text. */
const MIN_MAXIMUM_SCALE = 2;

/** Why a viewport tag is invalid. */
type ViewportKind = "multiple" | "no_width" | "fixed_width" | "zoom_disabled" | "initial_scale";

/**
 * A viewport property's number, or null when it is not one.
 *
 * @param value - The property as written.
 * @returns The number, or null.
 */
function scale(value: string | null): number | null {
	if (value === null || value.trim() === "") return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What is wrong with a page's viewport tags.
 *
 * @param viewports - The tags, as the markup states them.
 * @param platform - The platform that built the page, when known.
 * @returns The problems, in a stable order.
 */
function viewportProblems(
	viewports: readonly SeoPageViewport[],
	platform: string | null
): ViewportKind[] {
	const first = viewports[0];
	if (first === undefined) return [];
	const kinds: ViewportKind[] = [];
	if (viewports.length > 1) kinds.push("multiple");
	const width = (first.width ?? "").trim().toLowerCase();
	if (width === "") kinds.push("no_width");
	else if (width !== "device-width" && !(platform === "wix" && width === WIX_PHONE_WIDTH))
		kinds.push("fixed_width");
	const scalable = (first.userScalable ?? "").trim().toLowerCase();
	const maximum = scale(first.maximumScale);
	if (scalable === "no" || scalable === "0" || (maximum !== null && maximum < MIN_MAXIMUM_SCALE))
		kinds.push("zoom_disabled");
	const initial = scale(first.initialScale);
	if (initial !== null && initial !== 1) kinds.push("initial_scale");
	return kinds;
}

/**
 * The mobile and social findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function presentationFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const snapshot = indexableSnapshot(page, context);
	if (snapshot === null) return [];
	const key = page.pageKey;
	const facts = page.facts?.page ?? null;
	const markup = page.facts?.markup ?? null;
	const found: AuditFinding[] = [];
	const viewport = facts?.viewport ?? snapshot.viewport ?? "";
	if (viewport.trim() === "") found.push(finding(key, "viewport_missing"));
	else {
		const viewports = markup?.viewports ?? [];
		const problems = viewportProblems(viewports, markup?.platform ?? null);
		const width = scale(viewports[0]?.width ?? null);
		const wide = problems.includes("fixed_width") && width !== null && width >= WIDE_FIXED_WIDTH;
		if (wide) {
			found.push(finding(key, "viewport_fixed_width", { width, content: viewport.trim() }));
		}
		const kinds = wide ? problems.filter((kind) => kind !== "fixed_width") : problems;
		if (kinds.length > 0) {
			found.push(
				finding(key, "viewport_invalid", { kind: kinds[0], kinds, content: viewport.trim() })
			);
		}
	}
	const mobile = markup?.mobileAlternate ?? null;
	if (mobile !== null) {
		found.push(finding(key, "mobile_alternate_link", { url: mobile.url, media: mobile.media }));
	}
	const openGraph = facts?.hasOpenGraph ?? snapshot.hasOpenGraph;
	if (openGraph === false) found.push(finding(key, "open_graph_missing"));
	return found;
}
