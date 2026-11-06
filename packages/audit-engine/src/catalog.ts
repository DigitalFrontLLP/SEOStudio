/**
 * THE SITE AUDIT'S RULE CATALOG: every check the audit runs, by its stable id, with the one severity
 * it files under, the area of the site it is about, whether it judges a page or the whole site, and
 * whether the Dashboard may turn it into advice.
 *
 * ONE LIST, read by the rules (`./audit`, `./rules`, which file every finding under the severity named
 * here), the screen (which words each id through `seo.site_audit.rules.<id>`), the agent tools
 * and the recommendations engine. Pure data: no English, nothing that reads the environment.
 *
 * SEVERITIES (the owner, 2026-10-06: flag only real problems):
 * - `critical` (shown as an ERROR): the page or the site is broken for search or for people. Costs a
 *   page the most in the health score (`./score`).
 * - `warning`: a real problem worth fixing that does not break the page.
 * - `notice`: a small real problem, cheap to fix (a long title, an image without a size). Small fixes
 *   compound, so they stay listed (the owner, 2026-10-18).
 *
 * `sure` marks the checks the Dashboard may recommend (the precision rule, owner 2026-10-01): a
 * finding that is a FACT, always a real problem wherever it fires, and fixable by the site owner.
 *
 * `insight` marks a small improvement that is not a problem (an image in an older format, a typo the
 * dictionary flags): listed under the screen's Tips, never counted as an issue and never in the health
 * score.
 *
 * `crawlFact` marks a CRAWL FACT, not a finding (the owner, 2026-10-18: no notices that do not move
 * the needle; a noindex or not-indexed page is not bad): something often deliberate or fine (a noindex
 * page, a canonical to another page, a bare redirect), about the audit itself (a render that ran out of
 * time), or a duplicate of a check that already says what to fix. The audit still detects and stores
 * it exactly as before, and Crawl data still holds it (the issues download, the pages table, Check
 * pages), but it is never listed under Issues or Tips, never counted and never in the health score (it
 * is an insight too, so every place that leaves insights out leaves it out). Its harmful cases are
 * checks of their own (a noindex page that gets clicks, a sitemap that lists a noindex page).
 *
 * The accessibility checks (`a11y_*`) are generated from axe-core's own rule metadata
 * (`./a11y-rules.generated`): a rule axe rates critical or serious files as a warning, the rest as a
 * notice.
 */

import type { SeoSitePlatformValue } from "./facts";

import { SEO_A11Y_RULES } from "./a11y-rules.generated";
import type { SeoA11yImpact } from "./a11y-rules.generated";

/** How serious an issue is: an error, a warning or a notice. */
export type SeoAuditSeverity = "critical" | "warning" | "notice";

/**
 * The area of the site a check is about: ONE fixed list the screen groups the issues by, each with its
 * own score, and the agent tools filter by.
 */
export type SeoAuditCategory =
	| "indexing"
	| "redirects"
	| "links"
	| "content"
	| "metadata"
	| "structured_data"
	| "international"
	| "performance"
	| "mobile"
	| "accessibility"
	| "security"
	| "javascript"
	| "resources"
	| "social"
	| "google";

/** Whether a check judges one page, or the whole site (filed on the site's home page key). */
export type SeoAuditScope = "page" | "site";

/** One check as the catalog describes it. */
export interface SeoAuditRule {
	severity: SeoAuditSeverity;
	category: SeoAuditCategory;
	scope: SeoAuditScope;
	/** Whether the Dashboard may recommend fixing it on a page with traffic or a target. */
	sure: boolean;
	/** Whether it is an insight: a fact to filter on, not a problem to fix. */
	insight: boolean;
	/** Whether it is a crawl fact: stored and in Crawl data, never listed as an issue or a tip. */
	crawlFact: boolean;
}

/** Every category, in the order a tie between two categories is listed. */
export const SEO_AUDIT_CATEGORIES: readonly SeoAuditCategory[] = [
	"indexing",
	"redirects",
	"links",
	"content",
	"metadata",
	"structured_data",
	"international",
	"performance",
	"mobile",
	"accessibility",
	"security",
	"javascript",
	"resources",
	"social",
	"google"
];

/**
 * Whether a string is a category.
 *
 * @param value - The string.
 * @returns Whether it is one.
 */
export function isSeoAuditCategory(value: string): value is SeoAuditCategory {
	return new Set<string>(SEO_AUDIT_CATEGORIES).has(value);
}

/**
 * One value for every category.
 *
 * @param value - The value of a category.
 * @returns The values, by category.
 */
export function seoAuditByCategory<T>(
	value: (category: SeoAuditCategory) => T
): Record<SeoAuditCategory, T> {
	return {
		indexing: value("indexing"),
		redirects: value("redirects"),
		links: value("links"),
		content: value("content"),
		metadata: value("metadata"),
		structured_data: value("structured_data"),
		international: value("international"),
		performance: value("performance"),
		mobile: value("mobile"),
		accessibility: value("accessibility"),
		security: value("security"),
		javascript: value("javascript"),
		resources: value("resources"),
		social: value("social"),
		google: value("google")
	};
}

/** Every severity, most serious first. */
export const SEO_AUDIT_SEVERITIES: readonly SeoAuditSeverity[] = ["critical", "warning", "notice"];

/**
 * Whether a string is a severity.
 *
 * @param value - The string.
 * @returns Whether it is one.
 */
export function isSeoAuditSeverity(value: string): value is SeoAuditSeverity {
	return new Set<string>(SEO_AUDIT_SEVERITIES).has(value);
}

/**
 * A rule entry.
 *
 * @param severity - Its severity.
 * @param category - Its area.
 * @param options - `site` for a whole-site check, `sure` for one the Dashboard may recommend,
 *   `insight` for a fact that is not a problem, `fact` for a crawl fact (an insight never listed).
 * @returns The entry.
 */
function rule(
	severity: SeoAuditSeverity,
	category: SeoAuditCategory,
	options: { site?: boolean; sure?: boolean; insight?: boolean; fact?: boolean } = {}
): SeoAuditRule {
	return {
		severity,
		category,
		scope: options.site === true ? "site" : "page",
		sure: options.sure === true,
		insight: options.insight === true || options.fact === true,
		crawlFact: options.fact === true
	};
}

/**
 * An insight entry: a fact listed as a notice, never a problem by itself.
 *
 * @param category - Its area.
 * @param options - `site` for a whole-site fact.
 * @returns The entry.
 */
function insight(category: SeoAuditCategory, options: { site?: boolean } = {}): SeoAuditRule {
	return { ...rule("notice", category, options), insight: true };
}

/**
 * The accessibility checks' entries, one per axe-core rule.
 *
 * @param rules - The generated rules, by check id.
 * @returns Their catalog entries, by the same ids.
 */
function accessibilityRules<T extends Record<string, { impact: SeoA11yImpact }>>(
	rules: T
): { [K in keyof T]: SeoAuditRule } {
	const entries = Object.entries(rules).map(([id, entry]) => [
		id,
		rule(
			entry.impact === "critical" || entry.impact === "serious" ? "warning" : "notice",
			"accessibility"
		)
	]);
	return Object.fromEntries(entries) as { [K in keyof T]: SeoAuditRule };
}

/** Every check, by rule id. */
export const SEO_AUDIT_RULES = {
	// Indexing: what answered, what search engines may crawl and are told to index, the crawl files.
	unreachable: rule("critical", "indexing"),
	status_client_error: rule("critical", "indexing"),
	missing_page_with_visitors: rule("warning", "indexing"),
	status_server_error: rule("critical", "indexing"),
	crawl_blocked: rule("notice", "indexing"),
	crawl_rate_limited: rule("notice", "indexing", { site: true }),
	bad_content_type: rule("notice", "indexing"),
	soft_404_page: rule("warning", "indexing"),
	soft_404_catch_all: rule("warning", "indexing", { site: true }),
	url_too_long: rule("notice", "indexing", { fact: true }),
	robots_unreachable: rule("critical", "indexing", { site: true }),
	robots_syntax_error: rule("warning", "indexing", { site: true }),
	robots_blocked_url: rule("notice", "indexing", { fact: true, site: true }),
	sitemap_not_in_robots: rule("notice", "indexing", { site: true }),
	url_multiple_slashes: rule("notice", "indexing"),
	url_uppercase: rule("notice", "indexing", { fact: true }),
	url_whitespace: rule("notice", "indexing"),
	url_non_ascii: rule("notice", "indexing", { fact: true }),
	url_underscores: rule("notice", "indexing", { fact: true }),
	url_repetitive_path: rule("notice", "indexing"),
	url_default_slug: insight("indexing"),
	url_session_or_tracking: rule("warning", "indexing"),
	url_parameters: rule("notice", "indexing", { fact: true }),
	url_internal_search: rule("notice", "indexing"),
	url_ajax_fragment: rule("notice", "indexing"),
	url_technical_duplicate: rule("warning", "indexing"),
	html_structure_broken: rule("notice", "indexing"),
	html_over_2mb: rule("critical", "indexing", { sure: true }),
	html_over_2mb_minor: rule("warning", "indexing"),
	noindex: rule("notice", "indexing", { fact: true }),
	nofollow: rule("notice", "indexing", { fact: true }),
	canonical_missing: rule("notice", "indexing"),
	canonical_elsewhere: rule("notice", "indexing", { fact: true }),
	canonical_multiple: rule("warning", "indexing"),
	canonical_conflict: rule("warning", "indexing"),
	canonical_target_error: rule("critical", "indexing", { sure: true }),
	canonical_target_redirect: rule("warning", "indexing"),
	canonical_target_noindex: rule("warning", "indexing"),
	canonical_unlinked: rule("warning", "indexing"),
	sitemap_error_url: rule("warning", "indexing"),
	sitemap_redirect_url: rule("warning", "indexing"),
	sitemap_noindex_url: rule("warning", "indexing"),
	checkout_page_indexable: rule("notice", "indexing"),
	sitemap_non_canonical_url: rule("warning", "indexing"),
	sitemap_missing: rule("notice", "indexing", { site: true }),
	sitemap_empty: rule("notice", "indexing", { site: true }),
	sitemap_lastmod_uniform: rule("notice", "indexing", { site: true }),
	search_engine_blocked: rule("critical", "indexing", { site: true }),
	head_invalid_element: rule("critical", "indexing", { sure: true }),
	directive_outside_head: rule("critical", "indexing", { sure: true }),
	directives_mismatch: rule("warning", "indexing"),
	directives_duplicated: rule("notice", "indexing", { fact: true }),
	search_features_restricted: rule("notice", "indexing"),
	unavailable_after_passed: rule("warning", "indexing"),
	canonical_chain: rule("warning", "indexing"),
	canonical_target_disallowed: rule("warning", "indexing"),
	canonical_to_home: rule("warning", "indexing", { site: true }),
	canonical_external: rule("notice", "indexing", { fact: true }),
	canonical_protocol_mismatch: rule("warning", "indexing", { sure: true }),
	canonical_invalid: rule("warning", "indexing"),
	canonical_invalid_attributes: rule("warning", "indexing"),
	canonical_noindex_conflict: rule("notice", "indexing", { fact: true }),
	sitemap_disallowed_url: rule("warning", "indexing", { site: true }),
	sitemap_unreachable: rule("warning", "indexing", { site: true }),
	sitemap_invalid_xml: rule("warning", "indexing", { site: true }),
	sitemap_too_big: rule("critical", "indexing", { site: true }),
	sitemap_out_of_scope: rule("warning", "indexing", { site: true }),
	sitemap_extension_invalid: rule("warning", "indexing", { site: true }),
	sitemap_lastmod_invalid: rule("notice", "indexing", { site: true }),
	sitemap_deprecated_tags: rule("notice", "indexing", { fact: true, site: true }),
	sitemap_url_in_multiple: rule("notice", "indexing", { fact: true, site: true }),
	page_not_in_sitemap: rule("notice", "indexing"),
	paginated_canonical_to_first: rule("warning", "indexing"),
	pagination_not_linked: rule("notice", "indexing"),
	pagination_invalid: rule("notice", "indexing", { fact: true }),
	infinite_scroll_no_pages: rule("notice", "indexing"),
	amp_status_error: rule("warning", "indexing"),
	amp_canonical_invalid: rule("warning", "indexing"),
	amp_missing_return_link: rule("notice", "indexing"),
	amp_invalid: rule("warning", "indexing"),
	ai_search_crawlers_blocked: rule("warning", "indexing", { site: true }),
	ai_bots_inconsistent: rule("notice", "indexing", { fact: true, site: true }),
	content_signal_missing: rule("notice", "indexing", { fact: true, site: true }),
	llms_txt_invalid: rule("notice", "indexing", { fact: true, site: true }),
	markdown_alternate_missing: rule("notice", "indexing", { fact: true, site: true }),
	well_known_invalid: rule("notice", "indexing", { site: true }),
	// Redirects.
	redirect: rule("notice", "redirects", { fact: true }),
	redirect_chain: rule("warning", "redirects"),
	redirect_loop: rule("critical", "redirects", { sure: true }),
	redirect_unlinked: rule("notice", "redirects", { fact: true }),
	redirect_temporary: rule("notice", "redirects"),
	redirect_too_many: rule("critical", "redirects"),
	redirect_broken: rule("critical", "redirects", { sure: true }),
	redirect_https_to_http: rule("warning", "redirects", { sure: true }),
	redirect_slash_or_case: rule("notice", "redirects"),
	redirect_meta_refresh: rule("notice", "redirects"),
	redirect_http_refresh: rule("notice", "redirects"),
	redirect_javascript: rule("notice", "redirects"),
	host_variants_not_redirecting: rule("warning", "redirects", { site: true, sure: true }),
	host_variants_canonicalised: rule("notice", "redirects", { site: true }),
	// Links.
	base_tag_invalid: rule("warning", "links"),
	broken_internal_links: rule("critical", "links", { sure: true }),
	links_to_redirect: rule("notice", "links"),
	orphan: rule("warning", "links"),
	no_internal_links_out: rule("notice", "links"),
	links_localhost: rule("critical", "links", { sure: true }),
	links_localhost_in_text: rule("warning", "links"),
	links_malformed: rule("warning", "links"),
	links_space_in_query: rule("notice", "links", { fact: true }),
	links_uncrawlable: rule("warning", "links"),
	links_to_http: rule("warning", "links"),
	links_broken_bookmark: rule("notice", "links"),
	isolated_page: rule("warning", "links"),
	inlinks_nofollow_only: rule("warning", "links"),
	inlinks_follow_nofollow_mix: rule("notice", "links"),
	outlinks_internal_nofollow: rule("notice", "links"),
	inlinks_single: rule("notice", "links"),
	deep_page: rule("notice", "links"),
	anchor_missing: rule("notice", "links"),
	anchor_non_descriptive: rule("notice", "links"),
	outlinks_high: rule("notice", "links", { fact: true }),
	external_broken: rule("warning", "links"),
	document_broken: rule("warning", "links"),
	external_redirect: rule("notice", "links", { fact: true }),
	// Content: the words on the page and its headings.
	h1_missing: rule("warning", "content"),
	h1_multiple: rule("notice", "content"),
	h1_duplicate: rule("notice", "content"),
	h1_length: rule("notice", "content", { fact: true }),
	h2_facts: rule("notice", "content", { fact: true }),
	heading_skip: rule("notice", "content"),
	thin_content: rule("notice", "content"),
	lorem_ipsum: rule("warning", "content", { sure: true }),
	html_empty: rule("critical", "content", { sure: true }),
	spelling_errors: insight("content"),
	spelling_in_title: rule("notice", "content"),
	low_relevance: rule("notice", "content", { fact: true }),
	custom_search: insight("content"),
	linked_documents: rule("notice", "content", { fact: true }),
	document_title_missing: rule("notice", "content"),
	custom_script: insight("content"),
	ai_prompt: insight("content"),
	grammar_errors: insight("content"),
	readability_difficult: rule("notice", "content", { fact: true }),
	content_date_missing: rule("notice", "content", { fact: true }),
	eeat_signals: insight("content"),
	duplicate_content: rule("warning", "content"),
	duplicate_body: rule("warning", "content"),
	images_missing_alt: rule("notice", "content"),
	image_alt_quality: insight("content"),
	// Metadata: titles and meta descriptions.
	metadata_outside_head: rule("warning", "metadata"),
	title_missing: rule("critical", "metadata", { sure: true }),
	title_multiple: rule("warning", "metadata"),
	title_too_long: rule("notice", "metadata"),
	title_too_short: rule("notice", "metadata"),
	title_placeholder: rule("warning", "metadata", { sure: true }),
	title_same_as_description: rule("notice", "metadata"),
	title_serp_rewritten: rule("notice", "metadata"),
	meta_description_missing: rule("notice", "metadata"),
	meta_description_multiple: rule("warning", "metadata"),
	meta_description_too_long: rule("notice", "metadata"),
	meta_description_too_short: rule("notice", "metadata"),
	meta_description_placeholder: rule("warning", "metadata", { sure: true }),
	duplicate_title: rule("warning", "metadata"),
	duplicate_meta_description: rule("notice", "metadata"),
	metadata_templated: rule("warning", "metadata"),
	// Structured data.
	structured_data_missing: rule("notice", "structured_data", { fact: true }),
	schema_invalid_json: rule("warning", "structured_data", { sure: true }),
	schema_missing_context: rule("warning", "structured_data"),
	schema_missing_type: rule("notice", "structured_data"),
	schema_missing_required: rule("warning", "structured_data"),
	schema_placeholder: rule("warning", "structured_data"),
	schema_relative_url: rule("notice", "structured_data"),
	schema_retired_type: rule("notice", "structured_data", { fact: true }),
	schema_vocabulary_invalid: rule("warning", "structured_data"),
	schema_missing_recommended: rule("notice", "structured_data", { insight: true }),
	schema_type_expected: insight("structured_data"),
	product_schema_missing: rule("warning", "structured_data"),
	schema_content_mismatch: rule("warning", "structured_data"),
	structured_data_truncated: rule("notice", "structured_data", { fact: true }),
	rich_result_invalid_google: rule("warning", "structured_data"),
	// International: languages and regions.
	translation_missing: rule("warning", "international"),
	lang_missing: rule("notice", "international"),
	hreflang_invalid_code: rule("warning", "international"),
	hreflang_relative_url: rule("warning", "international"),
	hreflang_no_self: rule("warning", "international"),
	hreflang_no_return: rule("warning", "international"),
	hreflang_conflict: rule("warning", "international"),
	hreflang_to_non_canonical: rule("warning", "international"),
	hreflang_on_canonicalized: rule("warning", "international"),
	hreflang_missing_x_default: rule("notice", "international"),
	lang_body_mismatch: rule("warning", "international"),
	hreflang_target_error: rule("warning", "international"),
	hreflang_target_not_indexable: rule("warning", "international"),
	hreflang_inconsistent_codes: rule("warning", "international"),
	hreflang_lang_mismatch: rule("warning", "international"),
	hreflang_multiple_methods: rule("notice", "international", { fact: true }),
	hreflang_sitemap_invalid: rule("warning", "international", { site: true }),
	hreflang_group_incomplete: rule("notice", "international", { fact: true }),
	hreflang_page_unreferenced: rule("notice", "international", { fact: true }),
	hreflang_missing: rule("notice", "international", { site: true }),
	lang_invalid: rule("warning", "international"),
	// Performance: response, weight, images and Core Web Vitals, then the lab tests (Lighthouse, run by
	// PageSpeed Insights on a sample of pages).
	response_slow: rule("warning", "performance"),
	response_moderate: rule("notice", "performance", { fact: true }),
	page_moderate: rule("notice", "performance"),
	images_lazy_hero: rule("warning", "performance"),
	images_missing_dimensions: rule("notice", "performance"),
	compression_missing: rule("warning", "performance"),
	cache_policy_weak: rule("notice", "performance"),
	compression_missing_third_party: rule("notice", "performance", { fact: true }),
	cache_policy_weak_third_party: rule("notice", "performance", { fact: true }),
	image_incorrectly_sized: rule("notice", "performance"),
	image_offscreen_eager: rule("notice", "performance"),
	image_lcp_priority: insight("performance"),
	image_too_large: rule("notice", "performance"),
	image_legacy_format: insight("performance"),
	image_animated_gif: insight("performance"),
	image_srcset_missing: insight("performance"),
	network_payload_large: rule("notice", "performance"),
	document_large: rule("notice", "performance"),
	dom_size_excessive: rule("notice", "performance"),
	cwv_lcp_poor: rule("warning", "performance"),
	cwv_inp_poor: rule("warning", "performance"),
	cwv_cls_poor: rule("warning", "performance"),
	cwv_regressed: rule("warning", "performance"),
	lh_render_blocking: rule("warning", "performance"),
	lh_document_latency: rule("warning", "performance"),
	lh_lcp_discovery: rule("warning", "performance"),
	lh_network_dependency_tree: rule("warning", "performance"),
	lh_layout_shift_culprits: rule("warning", "performance"),
	lh_image_delivery: rule("warning", "performance"),
	lh_forced_reflow: rule("notice", "performance"),
	lh_legacy_javascript: rule("notice", "performance"),
	lh_duplicated_javascript: rule("notice", "performance"),
	lh_unused_css: rule("notice", "performance"),
	lh_unused_javascript: rule("notice", "performance"),
	lh_unminified: rule("notice", "performance"),
	lh_js_execution: rule("notice", "performance"),
	lh_main_thread: rule("notice", "performance"),
	lh_font_display: rule("notice", "performance"),
	lh_performance_score: rule("notice", "performance", { fact: true }),
	// Mobile.
	mobile_desktop_parity: rule("critical", "mobile"),
	unsupported_plugins: rule("notice", "mobile"),
	viewport_missing: rule("critical", "mobile", { sure: true }),
	viewport_invalid: rule("notice", "mobile"),
	viewport_fixed_width: rule("warning", "mobile"),
	mobile_alternate_link: rule("notice", "mobile", { fact: true }),
	content_not_sized: rule("warning", "mobile"),
	content_not_sized_severe: rule("critical", "mobile"),
	font_too_small: rule("notice", "mobile"),
	tap_targets_small: rule("notice", "mobile"),
	intrusive_interstitial: rule("warning", "mobile"),
	// Accessibility: axe-core's rules, generated.
	...accessibilityRules(SEO_A11Y_RULES),
	// Security.
	mixed_content_active: rule("critical", "security", { sure: true }),
	mixed_content_passive: rule("notice", "security"),
	security_headers_missing: rule("notice", "security", { site: true }),
	form_insecure: rule("warning", "security", { sure: true }),
	internal_http_page: rule("warning", "security", { sure: true }),
	protocol_relative_resources: rule("notice", "security", { fact: true }),
	tls_certificate: rule("warning", "security", { site: true }),
	// JavaScript: the page as a browser rendered it, against its raw HTML.
	render_failed: rule("notice", "javascript", { fact: true }),
	render_timeout: rule("notice", "javascript", { fact: true }),
	needs_javascript: rule("notice", "javascript"),
	js_links_only: rule("notice", "javascript"),
	js_title_changed: rule("notice", "javascript"),
	js_h1_changed: rule("notice", "javascript"),
	js_meta_description_changed: rule("notice", "javascript"),
	js_canonical_changed: rule("warning", "javascript"),
	js_canonical_raw_elsewhere: rule("critical", "javascript"),
	js_noindex_removed: rule("warning", "javascript"),
	js_noindex_added: rule("warning", "javascript"),
	js_nofollow_removed: rule("notice", "javascript"),
	js_structured_data_only: rule("notice", "javascript"),
	js_hreflang_changed: rule("notice", "javascript"),
	js_errors: rule("notice", "javascript"),
	js_back_button_hijack: rule("critical", "javascript"),
	// Resources: the files the pages load.
	resources_failed: rule("warning", "resources"),
	resources_blocked: rule("warning", "resources"),
	resources_blocked_minor: rule("notice", "resources", { fact: true }),
	resource_over_2mb: rule("warning", "resources"),
	image_broken: rule("warning", "resources", { sure: true }),
	resource_redirect: rule("notice", "resources"),
	// Social.
	open_graph_missing: rule("notice", "social"),
	social_tags_incomplete: rule("notice", "social"),
	og_url_not_canonical: rule("notice", "social"),
	og_image_broken: rule("notice", "social"),
	og_image_too_large: rule("notice", "social"),
	// Google data: what Search Console, URL Inspection and Analytics say about the pages.
	error_page_with_traffic: rule("critical", "google", { sure: true }),
	redirect_with_traffic: rule("notice", "google"),
	disallowed_with_traffic: rule("warning", "google"),
	noindex_with_traffic: rule("warning", "google"),
	canonicalised_with_traffic: rule("notice", "google"),
	indexable_not_indexed: rule("warning", "google", { fact: true }),
	google_canonical_differs: rule("warning", "google"),
	indexed_with_issues: rule("notice", "google"),
	no_search_data: rule("notice", "google", { fact: true }),
	analytics_tags: insight("google"),
	orphan_with_traffic: rule("warning", "google")
} as const satisfies Record<string, SeoAuditRule>;

/** Every rule id the audit files. */
export type SeoAuditRuleId = keyof typeof SEO_AUDIT_RULES;

/** Every rule id, in catalog order. */
export const SEO_AUDIT_RULE_IDS = Object.keys(SEO_AUDIT_RULES) as SeoAuditRuleId[];

/**
 * Whether a string is a rule id the catalog knows.
 *
 * @param value - The string.
 * @returns Whether it is one.
 */
export function isSeoAuditRuleId(value: string): value is SeoAuditRuleId {
	return Object.hasOwn(SEO_AUDIT_RULES, value);
}

/**
 * THE TRAFFIC JOINS, by the finding each is joined from: on a page that still gets visitors from search
 * (an error page also from Analytics), the join stands for that finding, so the fact is filed once.
 */
export const SEO_AUDIT_TRAFFIC_JOINS: Readonly<Partial<Record<SeoAuditRuleId, SeoAuditRuleId>>> = {
	status_client_error: "error_page_with_traffic",
	status_server_error: "error_page_with_traffic",
	noindex: "noindex_with_traffic",
	canonical_elsewhere: "canonicalised_with_traffic",
	orphan: "orphan_with_traffic",
	redirect: "redirect_with_traffic"
};

/** The structured data checks of our own that find what Google's rich results verdict would. */
const SCHEMA_ERRORS: readonly SeoAuditRuleId[] = [
	"schema_invalid_json",
	"schema_missing_context",
	"schema_missing_type",
	"schema_missing_required",
	"schema_placeholder",
	"schema_relative_url",
	"schema_vocabulary_invalid",
	"schema_content_mismatch"
];

/**
 * ONE FACT, FILED ONCE: each check another check on the same page makes redundant, with the checks that
 * do, besides the traffic joins ({@link SEO_AUDIT_TRAFFIC_JOINS}). A specific redirect check stands for
 * the bare redirect (a script redirect ending on an error page for the bare script redirect), a
 * canonical to a broken page (which search engines ignore) for the bare canonical
 * and for the sitemap listing the page instead of that broken target, hreflang on a page canonicalised
 * elsewhere for that bare canonical (one root cause), the canonical to another page for
 * the canonical to another domain it names, our own structured data checks for Google's rich results
 * verdict on the same markup, an empty page for its missing text and H1 and for every head tag and link
 * an empty document lacks (an endpoint answering 200 with no body is one empty page, not also a page
 * without a title, a viewport and links), an untranslated language version for its text read as
 * another language, a placeholder title or description for the same text on other pages, and a product
 * page without Product markup for its missing or unmatched structured data. A check that stands for one
 * that stands for another stands for both.
 */
const SUPERSEDING: readonly (readonly [SeoAuditRuleId, readonly SeoAuditRuleId[]])[] = [
	["title_missing", ["html_empty"]],
	["viewport_missing", ["html_empty"]],
	["meta_description_missing", ["html_empty"]],
	["lang_missing", ["html_empty"]],
	["open_graph_missing", ["html_empty"]],
	["no_internal_links_out", ["html_empty"]],
	["thin_content", ["html_empty"]],
	["h1_missing", ["html_empty"]],
	["canonical_elsewhere", ["canonical_target_error", "hreflang_on_canonicalized"]],
	["canonical_external", ["canonical_elsewhere"]],
	["sitemap_non_canonical_url", ["canonical_target_error"]],
	[
		"redirect",
		[
			"redirect_chain",
			"redirect_loop",
			"redirect_too_many",
			"redirect_broken",
			"redirect_temporary",
			"redirect_https_to_http",
			"redirect_slash_or_case"
		]
	],
	["redirect_javascript", ["redirect_broken"]],
	["rich_result_invalid_google", SCHEMA_ERRORS],
	["lang_body_mismatch", ["translation_missing"]],
	["duplicate_title", ["title_placeholder"]],
	["duplicate_meta_description", ["meta_description_placeholder"]],
	["structured_data_missing", ["product_schema_missing", "html_empty"]],
	["schema_type_expected", ["product_schema_missing"]]
];

/**
 * Each check with every check that makes it redundant on the same page: {@link SUPERSEDING} and the
 * traffic joins, followed through (what stands for a check's stand-in stands for the check too).
 *
 * @returns The checks, each with the checks that stand for it.
 */
function supersededBy(): ReadonlyMap<SeoAuditRuleId, readonly SeoAuditRuleId[]> {
	const direct = new Map<SeoAuditRuleId, SeoAuditRuleId[]>(
		SUPERSEDING.map(([ruleId, by]) => [ruleId, [...by]])
	);
	for (const [ruleId, join] of Object.entries(SEO_AUDIT_TRAFFIC_JOINS)) {
		if (!isSeoAuditRuleId(ruleId) || join === undefined) continue;
		direct.set(ruleId, [...(direct.get(ruleId) ?? []), join]);
	}
	const closed = new Map<SeoAuditRuleId, readonly SeoAuditRuleId[]>();
	for (const ruleId of direct.keys()) {
		const all = new Set<SeoAuditRuleId>();
		const queue = [...(direct.get(ruleId) ?? [])];
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			if (next === ruleId || all.has(next)) continue;
			all.add(next);
			queue.push(...(direct.get(next) ?? []));
		}
		closed.set(ruleId, [...all]);
	}
	return closed;
}

/** Each check with every check on the same page that makes it redundant ({@link supersededBy}). */
export const SEO_AUDIT_SUPERSEDED_BY: ReadonlyMap<SeoAuditRuleId, readonly SeoAuditRuleId[]> =
	supersededBy();

/**
 * A rule's catalog entry, or null for an id the catalog no longer knows (an issue stored by an older
 * build).
 *
 * @param ruleId - The rule id.
 * @returns The entry, or null.
 */
export function seoAuditRule(ruleId: string): SeoAuditRule | null {
	return isSeoAuditRuleId(ruleId) ? SEO_AUDIT_RULES[ruleId] : null;
}

/** The rule ids the Dashboard may recommend fixing (`sure`), in catalog order. */
export const SEO_AUDIT_SURE_RULES: readonly SeoAuditRuleId[] = SEO_AUDIT_RULE_IDS.filter(
	(id) => SEO_AUDIT_RULES[id].sure
);

/** The rule ids that file a fact rather than a problem (insights), in catalog order. */
export const SEO_AUDIT_INSIGHT_RULES: readonly SeoAuditRuleId[] = SEO_AUDIT_RULE_IDS.filter(
	(id) => SEO_AUDIT_RULES[id].insight
);

/** The rule ids that file a crawl fact (never listed as an issue or a tip), in catalog order. */
export const SEO_AUDIT_CRAWL_FACT_RULES: readonly SeoAuditRuleId[] = SEO_AUDIT_RULE_IDS.filter(
	(id) => SEO_AUDIT_RULES[id].crawlFact
);

/**
 * Whether a check files a crawl fact: stored and in Crawl data, never listed as an issue or a tip.
 *
 * @param ruleId - The check's id.
 * @returns Whether it does; false for an id the catalog no longer knows.
 */
export function isSeoAuditCrawlFact(ruleId: string): boolean {
	return isSeoAuditRuleId(ruleId) && SEO_AUDIT_RULES[ruleId].crawlFact;
}

/**
 * THE CHECKS FIXED BY CHANGING A PAGE'S WORDS (owner, 2026-10-17: every content change goes through
 * the content writer, with its score, judge and editor): only the title in Google and the meta
 * description ({@link SEO_AUDIT_TITLE_DESCRIPTION_CHECKS}), the headings and the body text. Every other
 * check is technical and stays with the fix skill.
 */
export const SEO_AUDIT_TITLE_DESCRIPTION_CHECKS: readonly SeoAuditRuleId[] = [
	"title_missing",
	"title_too_long",
	"title_too_short",
	"title_placeholder",
	"title_same_as_description",
	"title_serp_rewritten",
	"spelling_in_title",
	"meta_description_missing",
	"meta_description_too_long",
	"meta_description_too_short",
	"meta_description_placeholder",
	"duplicate_title",
	"duplicate_meta_description",
	"metadata_templated"
];

/** The content checks that need the page's text written anew, not a small edit. */
export const SEO_AUDIT_BODY_CHECKS: readonly SeoAuditRuleId[] = [
	"thin_content",
	"duplicate_content",
	"duplicate_body",
	"lorem_ipsum"
];

/** Every check fixed by changing a page's words: its title and description, its headings, its body. */
export const SEO_AUDIT_CONTENT_CHECKS: readonly SeoAuditRuleId[] = [
	...SEO_AUDIT_TITLE_DESCRIPTION_CHECKS,
	"h1_missing",
	"h1_multiple",
	"h1_duplicate",
	"heading_skip",
	...SEO_AUDIT_BODY_CHECKS
];

/**
 * Whether a check is fixed by changing a page's words ({@link SEO_AUDIT_CONTENT_CHECKS}).
 *
 * @param ruleId - The check's id.
 * @returns Whether it is.
 */
export function isSeoAuditContentCheck(ruleId: string): boolean {
	return (SEO_AUDIT_CONTENT_CHECKS as readonly string[]).includes(ruleId);
}

/**
 * The site builders and frameworks the audit recognises (`./extract-markup`), each with one
 * fix hint per {@link SeoAuditHintTopic} in the messages (`site_audit.platforms.hints.<platform>`).
 */
export const SEO_AUDIT_PLATFORMS = [
	"squarespace",
	"wix",
	"shopify",
	"wordpress",
	"ghost",
	"webflow",
	"nextjs",
	"discourse",
	"framer",
	"joomla",
	"prestashop",
	"nuxt"
] as const satisfies readonly SeoSitePlatformValue[];

/** A site builder or framework the audit recognises. */
export type SeoAuditPlatform = (typeof SEO_AUDIT_PLATFORMS)[number];

/**
 * What a platform changes about a fix: where the canonical, the sitemap, the titles and descriptions,
 * the redirects, the noindex switch, the structured data and the images' alt text are set, how it
 * gets the main text into the HTML, and the canonical of a list's later pages.
 */
export type SeoAuditHintTopic =
	| "canonical"
	| "sitemap"
	| "titles"
	| "redirects"
	| "noindex"
	| "structured_data"
	| "images"
	| "rendering"
	| "pagination";

/**
 * THE CHECKS WHOSE FIX DEPENDS ON THE PLATFORM, by the topic of their platform hint. Content, not
 * code: a check gains a hint by being listed here, and each platform's line is in the messages.
 */
const HINT_TOPICS: Readonly<Record<SeoAuditHintTopic, readonly SeoAuditRuleId[]>> = {
	canonical: [
		"canonical_missing",
		"canonical_multiple",
		"canonical_to_home",
		"canonical_target_error",
		"canonical_target_redirect",
		"canonical_target_noindex",
		"canonical_protocol_mismatch",
		"canonical_chain"
	],
	sitemap: [
		"sitemap_missing",
		"sitemap_empty",
		"sitemap_non_canonical_url",
		"sitemap_noindex_url",
		"sitemap_redirect_url",
		"sitemap_error_url",
		"page_not_in_sitemap"
	],
	titles: [
		"title_missing",
		"title_multiple",
		"title_too_long",
		"title_too_short",
		"duplicate_title",
		"meta_description_missing",
		"meta_description_multiple",
		"meta_description_too_long",
		"meta_description_too_short",
		"duplicate_meta_description",
		"title_placeholder",
		"meta_description_placeholder",
		"metadata_templated"
	],
	redirects: ["redirect_chain", "redirect_temporary", "redirect_loop", "redirect_too_many"],
	noindex: ["noindex", "noindex_with_traffic"],
	structured_data: [
		"structured_data_missing",
		"product_schema_missing",
		"schema_invalid_json",
		"schema_missing_context",
		"schema_missing_type",
		"schema_missing_required",
		"schema_placeholder",
		"schema_vocabulary_invalid",
		"schema_content_mismatch",
		"schema_relative_url",
		"rich_result_invalid_google"
	],
	images: ["images_missing_alt"],
	rendering: ["needs_javascript"],
	pagination: ["paginated_canonical_to_first"]
};

/** Each check's hint topic, for the checks that have one. */
const HINT_TOPIC_OF: ReadonlyMap<string, SeoAuditHintTopic> = new Map(
	Object.entries(HINT_TOPICS).flatMap(([topic, ids]) =>
		ids.map((id) => [id, topic as SeoAuditHintTopic] as const)
	)
);

/**
 * Whether a string is a platform the audit recognises.
 *
 * @param value - The string.
 * @returns Whether it is one.
 */
export function isSeoAuditPlatform(value: unknown): value is SeoSitePlatformValue {
	return typeof value === "string" && new Set<string>(SEO_AUDIT_PLATFORMS).has(value);
}

/**
 * The topic of a check's platform hint, or null when its fix is the same on every platform.
 *
 * @param ruleId - The check.
 * @returns The topic, or null.
 */
export function seoAuditHintTopic(ruleId: string): SeoAuditHintTopic | null {
	return HINT_TOPIC_OF.get(ruleId) ?? null;
}
