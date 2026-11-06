import type { SeoPageBadLinkKindValue, SeoPageMarkupFacts } from "../facts";
import { normalizePageUrl } from "../urls";

import type { SeoAuditRuleId } from "../catalog";
import { LINK_THRESHOLDS } from "./architecture";
import { AUDIT_EXAMPLES, finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";
import { holdsBookmark } from "./site-page";

/**
 * THE LINK RULES THE PAGE'S OWN MARKUP ANSWERS: links that leak a local address, hrefs a crawler cannot
 * read, links only a script can follow, bookmarks whose target is not there, and pages holding very
 * many links. Judged from the markup facts of the page as stored (the rendered page whenever the
 * browser rendered it), so a link a script fixes up is judged as the visitor gets it.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS: a link to a local address is an error in the page's template and
 * a warning (`links_localhost_in_text`) when every such link sits in an article's running text (a
 * tutorial that links `localhost:3000`, often on purpose); a `javascript:` link that navigates nowhere (a menu toggle) is a
 * button, not a link (the extractor leaves it out), and an empty href names the page itself; a fragment link is judged against another page's
 * ids only when every id of that page was kept; an element other than a link counts as one only when
 * the rendered page says so (a link role, or a URL in a data attribute under a pointer cursor) and no
 * real link sits in or around it. A space in a link's path, query string or fragment is a notice
 * (`links_space_in_query`): browsers and search engines percent-encode it and open the page; an address
 * that stays broken once its spaces are encoded is `links_malformed`.
 */

/**
 * Which rule each kind of bad href is filed under; an empty href is none: it names the page itself, so
 * browsers open it and crawlers read it as the page they are on (a menu's Back or toggle control).
 */
const BAD_LINK_RULES: Record<SeoPageBadLinkKindValue, SeoAuditRuleId | null> = {
	localhost: "links_localhost",
	file: "links_localhost",
	empty: null,
	whitespace: "links_space_in_query",
	whitespace_query: "links_space_in_query",
	malformed: "links_malformed",
	protocol: "links_malformed",
	javascript: "links_uncrawlable",
	onclick: "links_uncrawlable"
};

/**
 * The bad-href findings of a page, one per rule however many kinds feed it; elements the rendered page
 * makes act as links without being links (a link role, a URL in a data attribute, as the render's probe
 * found them) are links a crawler cannot follow too. Each example carries its anchor text when the
 * read kept it (`links`), so the reader can find the link on the page.
 *
 * @param pageKey - The page.
 * @param markup - Its markup facts.
 * @param fakeLinks - The rendered page's elements acting as links, when the probe ran.
 * @returns The findings.
 */
function badLinkFindings(
	pageKey: string,
	markup: SeoPageMarkupFacts | null,
	fakeLinks: { count: number; examples: string[] } | null
): AuditFinding[] {
	const byRule = new Map<
		SeoAuditRuleId,
		{ count: number; examples: string[]; links: { href: string; anchor: string }[] }
	>();
	const local = (markup?.badLinks ?? []).filter(
		(entry) => BAD_LINK_RULES[entry.kind] === "links_localhost"
	);
	const localInText =
		local.length > 0 && local.every((entry) => (entry.inText ?? 0) >= entry.count);
	for (const entry of markup?.badLinks ?? []) {
		const named = BAD_LINK_RULES[entry.kind];
		if (named === null) continue;
		const ruleId = named === "links_localhost" && localInText ? "links_localhost_in_text" : named;
		const held = byRule.get(ruleId) ?? { count: 0, examples: [], links: [] };
		held.count += entry.count;
		held.examples.push(...entry.examples);
		const anchors = entry.anchors;
		if (anchors !== undefined && anchors.length === entry.examples.length) {
			entry.examples.forEach((href, index) => {
				const anchor = anchors[index] ?? "";
				if (!held.links.some((link) => link.href === href && link.anchor === anchor))
					held.links.push({ href, anchor });
			});
		}
		byRule.set(ruleId, held);
	}
	const elements = fakeLinks !== null && fakeLinks.count > 0 ? fakeLinks : null;
	if (elements !== null && !byRule.has("links_uncrawlable")) {
		byRule.set("links_uncrawlable", { count: 0, examples: [], links: [] });
	}
	return [...byRule].map(([ruleId, held]) => {
		const withElements = ruleId === "links_uncrawlable" && elements !== null;
		return finding(pageKey, ruleId, {
			count: held.count + (withElements ? elements.count : 0),
			examples: [...new Set(held.examples)].slice(0, AUDIT_EXAMPLES),
			...(held.links.length === 0 ? {} : { links: held.links.slice(0, AUDIT_EXAMPLES) }),
			...(withElements ? { elements: elements.examples.slice(0, AUDIT_EXAMPLES) } : {})
		});
	});
}

/**
 * The links to another page's fragment whose target page was read with every id kept and holds no
 * element of that id.
 *
 * @param markup - The linking page's markup facts.
 * @param context - The audit.
 * @returns The fragment links, as `url#fragment`.
 */
function missingExternalBookmarks(markup: SeoPageMarkupFacts, context: AuditContext): string[] {
	const missing: string[] = [];
	for (const { url, fragment } of markup.bookmarks.external) {
		const key = normalizePageUrl(url);
		if (key === null) continue;
		const target = context.byKey.get(context.resolve(key));
		if (target === undefined || htmlSnapshot(target) === null) continue;
		const ids = target.facts?.markup?.bookmarks;
		if (ids === undefined || ids.idsTruncated || holdsBookmark(ids, fragment)) continue;
		missing.push(`${url}#${fragment}`);
	}
	return missing;
}

/**
 * The link markup findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function linkMarkupFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	if (htmlSnapshot(page) === null) return [];
	const found: AuditFinding[] = [];
	const markup = page.facts?.markup;
	const render = page.facts?.render;
	const fakeLinks =
		render != null && render.outcome !== "failed" ? (render.dom?.fakeLinks ?? null) : null;
	found.push(...badLinkFindings(page.pageKey, markup ?? null, fakeLinks));
	if (markup != null) {
		const external = missingExternalBookmarks(markup, context);
		const count = markup.bookmarks.missingCount + external.length;
		if (count > 0) {
			found.push(
				finding(page.pageKey, "links_broken_bookmark", {
					count,
					missing: markup.bookmarks.missing.map((fragment) => `#${fragment}`),
					urls: external.slice(0, AUDIT_EXAMPLES)
				})
			);
		}
	}
	const internal = page.facts?.page?.internalLinks ?? 0;
	const external = page.facts?.page?.externalLinks ?? 0;
	if (
		internal > LINK_THRESHOLDS.outlinksHighInternal ||
		external > LINK_THRESHOLDS.outlinksHighExternal
	) {
		found.push(finding(page.pageKey, "outlinks_high", { internal, external }));
	}
	return found;
}
