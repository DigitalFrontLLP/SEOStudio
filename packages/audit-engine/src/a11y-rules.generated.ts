// GENERATED from the rule metadata of axe-core 4.13.0. Do not edit by hand.

/** How serious axe-core rates a failure of a rule. */
export type SeoA11yImpact = "critical" | "serious" | "moderate" | "minor";

/**
 * Every accessibility check, by its site audit id: the axe-core rule it runs, the rule's impact, and
 * whether the server runs it (the search-relevant subset; the desktop app runs them all).
 */
export const SEO_A11Y_RULES = {
	a11y_accesskeys: { axe: "accesskeys", impact: "serious", seo: false },
	a11y_area_alt: { axe: "area-alt", impact: "critical", seo: false },
	a11y_aria_allowed_attr: { axe: "aria-allowed-attr", impact: "critical", seo: false },
	a11y_aria_allowed_role: { axe: "aria-allowed-role", impact: "minor", seo: false },
	a11y_aria_braille_equivalent: { axe: "aria-braille-equivalent", impact: "serious", seo: false },
	a11y_aria_command_name: { axe: "aria-command-name", impact: "serious", seo: true },
	a11y_aria_conditional_attr: { axe: "aria-conditional-attr", impact: "serious", seo: false },
	a11y_aria_deprecated_role: { axe: "aria-deprecated-role", impact: "minor", seo: false },
	a11y_aria_dialog_name: { axe: "aria-dialog-name", impact: "serious", seo: true },
	a11y_aria_hidden_body: { axe: "aria-hidden-body", impact: "critical", seo: false },
	a11y_aria_hidden_focus: { axe: "aria-hidden-focus", impact: "serious", seo: false },
	a11y_aria_input_field_name: { axe: "aria-input-field-name", impact: "serious", seo: true },
	a11y_aria_meter_name: { axe: "aria-meter-name", impact: "serious", seo: true },
	a11y_aria_progressbar_name: { axe: "aria-progressbar-name", impact: "serious", seo: true },
	a11y_aria_prohibited_attr: { axe: "aria-prohibited-attr", impact: "serious", seo: false },
	a11y_aria_required_attr: { axe: "aria-required-attr", impact: "critical", seo: false },
	a11y_aria_required_children: { axe: "aria-required-children", impact: "critical", seo: false },
	a11y_aria_required_parent: { axe: "aria-required-parent", impact: "critical", seo: false },
	a11y_aria_roles: { axe: "aria-roles", impact: "critical", seo: false },
	a11y_aria_tab_name: { axe: "aria-tab-name", impact: "serious", seo: true },
	a11y_aria_text: { axe: "aria-text", impact: "serious", seo: false },
	a11y_aria_toggle_field_name: { axe: "aria-toggle-field-name", impact: "serious", seo: true },
	a11y_aria_tooltip_name: { axe: "aria-tooltip-name", impact: "serious", seo: true },
	a11y_aria_treeitem_name: { axe: "aria-treeitem-name", impact: "serious", seo: true },
	a11y_aria_valid_attr: { axe: "aria-valid-attr", impact: "critical", seo: false },
	a11y_aria_valid_attr_value: { axe: "aria-valid-attr-value", impact: "critical", seo: false },
	a11y_autocomplete_valid: { axe: "autocomplete-valid", impact: "serious", seo: false },
	a11y_avoid_inline_spacing: { axe: "avoid-inline-spacing", impact: "serious", seo: false },
	a11y_blink: { axe: "blink", impact: "serious", seo: false },
	a11y_button_name: { axe: "button-name", impact: "critical", seo: true },
	a11y_bypass: { axe: "bypass", impact: "serious", seo: false },
	a11y_color_contrast: { axe: "color-contrast", impact: "serious", seo: false },
	a11y_definition_list: { axe: "definition-list", impact: "serious", seo: false },
	a11y_dlitem: { axe: "dlitem", impact: "serious", seo: false },
	a11y_duplicate_id_aria: { axe: "duplicate-id-aria", impact: "critical", seo: true },
	a11y_empty_heading: { axe: "empty-heading", impact: "minor", seo: true },
	a11y_empty_table_header: { axe: "empty-table-header", impact: "minor", seo: false },
	a11y_form_field_multiple_labels: {
		axe: "form-field-multiple-labels",
		impact: "moderate",
		seo: false
	},
	a11y_frame_focusable_content: { axe: "frame-focusable-content", impact: "serious", seo: false },
	a11y_frame_title: { axe: "frame-title", impact: "serious", seo: true },
	a11y_frame_title_unique: { axe: "frame-title-unique", impact: "serious", seo: false },
	a11y_html_xml_lang_mismatch: { axe: "html-xml-lang-mismatch", impact: "moderate", seo: false },
	a11y_image_redundant_alt: { axe: "image-redundant-alt", impact: "minor", seo: false },
	a11y_input_button_name: { axe: "input-button-name", impact: "critical", seo: true },
	a11y_input_image_alt: { axe: "input-image-alt", impact: "critical", seo: true },
	a11y_label: { axe: "label", impact: "critical", seo: true },
	a11y_label_title_only: { axe: "label-title-only", impact: "serious", seo: false },
	a11y_landmark_banner_is_top_level: {
		axe: "landmark-banner-is-top-level",
		impact: "moderate",
		seo: false
	},
	a11y_landmark_contentinfo_is_top_level: {
		axe: "landmark-contentinfo-is-top-level",
		impact: "moderate",
		seo: false
	},
	a11y_landmark_main_is_top_level: {
		axe: "landmark-main-is-top-level",
		impact: "moderate",
		seo: false
	},
	a11y_landmark_no_duplicate_banner: {
		axe: "landmark-no-duplicate-banner",
		impact: "moderate",
		seo: false
	},
	a11y_landmark_no_duplicate_contentinfo: {
		axe: "landmark-no-duplicate-contentinfo",
		impact: "moderate",
		seo: false
	},
	a11y_landmark_no_duplicate_main: {
		axe: "landmark-no-duplicate-main",
		impact: "moderate",
		seo: false
	},
	a11y_landmark_one_main: { axe: "landmark-one-main", impact: "moderate", seo: false },
	a11y_landmark_unique: { axe: "landmark-unique", impact: "moderate", seo: false },
	a11y_link_in_text_block: { axe: "link-in-text-block", impact: "serious", seo: false },
	a11y_list: { axe: "list", impact: "serious", seo: false },
	a11y_listitem: { axe: "listitem", impact: "serious", seo: false },
	a11y_marquee: { axe: "marquee", impact: "serious", seo: false },
	a11y_meta_viewport_large: { axe: "meta-viewport-large", impact: "minor", seo: false },
	a11y_nested_interactive: { axe: "nested-interactive", impact: "serious", seo: false },
	a11y_no_autoplay_audio: { axe: "no-autoplay-audio", impact: "moderate", seo: false },
	a11y_object_alt: { axe: "object-alt", impact: "serious", seo: false },
	a11y_presentation_role_conflict: {
		axe: "presentation-role-conflict",
		impact: "minor",
		seo: false
	},
	a11y_region: { axe: "region", impact: "moderate", seo: false },
	a11y_role_img_alt: { axe: "role-img-alt", impact: "serious", seo: true },
	a11y_scope_attr_valid: { axe: "scope-attr-valid", impact: "moderate", seo: false },
	a11y_scrollable_region_focusable: {
		axe: "scrollable-region-focusable",
		impact: "serious",
		seo: false
	},
	a11y_select_name: { axe: "select-name", impact: "critical", seo: true },
	a11y_server_side_image_map: { axe: "server-side-image-map", impact: "minor", seo: false },
	a11y_skip_link: { axe: "skip-link", impact: "moderate", seo: false },
	a11y_summary_name: { axe: "summary-name", impact: "serious", seo: true },
	a11y_svg_img_alt: { axe: "svg-img-alt", impact: "serious", seo: true },
	a11y_tabindex: { axe: "tabindex", impact: "serious", seo: false },
	a11y_table_duplicate_name: { axe: "table-duplicate-name", impact: "minor", seo: false },
	a11y_td_headers_attr: { axe: "td-headers-attr", impact: "serious", seo: false },
	a11y_th_has_data_cells: { axe: "th-has-data-cells", impact: "serious", seo: false },
	a11y_valid_lang: { axe: "valid-lang", impact: "serious", seo: true },
	a11y_video_caption: { axe: "video-caption", impact: "critical", seo: false }
} as const satisfies Record<string, { axe: string; impact: SeoA11yImpact; seo: boolean }>;

/** The axe-core rules left out because another check of the audit files the same fact. */
export const SEO_A11Y_COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
	"image-alt": "images_missing_alt",
	"document-title": "title_missing",
	"html-has-lang": "lang_missing",
	"html-lang-valid": "lang_invalid",
	"page-has-heading-one": "h1_missing",
	"heading-order": "heading_skip",
	"link-name": "anchor_missing",
	"target-size": "tap_targets_small",
	"meta-refresh": "redirect_meta_refresh",
	"meta-viewport": "viewport_invalid",
	"frame-tested": "(not a check: asks for frames to be tested)"
};
