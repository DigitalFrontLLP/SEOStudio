import { SEO_AUDIT_RULES } from "../catalog";
import type { SeoAuditRuleId } from "../catalog";

/**
 * WHAT STILL JUDGES A NOINDEX PAGE. Search engines leave a page that says `noindex` out of their
 * results, so what it says (title, description, headings, words, duplicates, images, markup) cannot
 * move them, and those checks never judge it: a noindex page is often one of thousands made from one
 * template (a profile, a cart, a filtered listing), and judging its content would bury the pages that
 * rank. What it does to the whole site still counts: whether it answers (its status, a server error),
 * a slow server, broken links and links through redirects from it, redirects, the Core Web Vitals
 * measured for it, the directive itself and what contradicts it (a canonical, the other directive
 * source, a script that adds or removes it, a head that breaks it), the sitemap and search data naming
 * it, and the whole-site checks.
 */

/** The page checks named one by one that still judge a noindex page. */
const NOINDEX_PAGE_CHECKS: ReadonlySet<string> = new Set([
	"unreachable",
	"crawl_blocked",
	"robots_blocked_url",
	"noindex",
	"nofollow",
	"canonical_elsewhere",
	"canonical_noindex_conflict",
	"directives_mismatch",
	"directives_duplicated",
	"directive_outside_head",
	"head_invalid_element",
	"js_noindex_added",
	"js_noindex_removed",
	"js_nofollow_removed",
	"response_slow",
	"broken_internal_links",
	"external_broken",
	"links_to_redirect",
	"cwv_lcp_poor",
	"cwv_inp_poor",
	"cwv_cls_poor",
	"cwv_regressed"
]);

/**
 * Whether a check still judges a page that says `noindex`.
 *
 * @param ruleId - The check.
 * @returns Whether it does.
 */
export function judgesNoindexPage(ruleId: SeoAuditRuleId): boolean {
	const rule = SEO_AUDIT_RULES[ruleId];
	return (
		rule.scope === "site" ||
		rule.category === "redirects" ||
		(rule.category === "google" && ruleId !== "analytics_tags") ||
		NOINDEX_PAGE_CHECKS.has(ruleId) ||
		/^(?:status|sitemap)_/.test(ruleId)
	);
}
