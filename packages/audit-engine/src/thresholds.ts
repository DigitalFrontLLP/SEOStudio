import type { SeoAuditRuleId } from "./catalog";

/**
 * THE AUDIT THRESHOLDS A PROJECT MAY CHANGE (crawl settings, Advanced): the tuned default of each, the
 * range a member may set it to, and the checks it judges. Experts change them per project; everyone
 * else keeps the defaults. A finding judged with a changed threshold is marked "custom" on the page
 * and to agents, and the audit day records which thresholds were changed, so a score judged with them
 * is never read as comparable to one judged with the defaults. Pure data: the settings validator, the
 * rules and the screens read it.
 */

/** One threshold a project may change. */
export interface SeoAuditThresholdSpec {
	/** The tuned default. */
	value: number;
	/** The least and the most a project may set. */
	min: number;
	max: number;
	/** The unit the value is in, for the form. */
	unit: "px" | "words" | "percent" | "ms" | "kb" | "hops" | "chars" | "clicks";
	/** The checks it judges. */
	rules: readonly SeoAuditRuleId[];
}

/** Every threshold a project may change, by its key. */
export const SEO_AUDIT_THRESHOLD_SPECS = {
	/** Title width on Google's results page past which it is cut. */
	titleMaxPx: { value: 580, min: 300, max: 1200, unit: "px", rules: ["title_too_long"] },
	/** Title width under which it is short. */
	titleMinPx: { value: 200, min: 0, max: 600, unit: "px", rules: ["title_too_short"] },
	/** Description width on Google's results page past which it is cut. */
	descriptionMaxPx: {
		value: 990,
		min: 400,
		max: 2000,
		unit: "px",
		rules: ["meta_description_too_long"]
	},
	/** Description width under which it is short. */
	descriptionMinPx: {
		value: 400,
		min: 0,
		max: 1200,
		unit: "px",
		rules: ["meta_description_too_short"]
	},
	/** Main-text words under which a page has little text. */
	thinWords: { value: 300, min: 0, max: 5000, unit: "words", rules: ["thin_content"] },
	/** How much two main texts overlap, in percent, from which they are near-duplicates. */
	nearDuplicatePercent: {
		value: 90,
		min: 80,
		max: 99,
		unit: "percent",
		rules: ["duplicate_content"]
	},
	/** Server answer time past which a page is very slow (measured from our crawler). */
	slowMs: { value: 3000, min: 500, max: 30_000, unit: "ms", rules: ["response_slow"] },
	/** Server answer time past which a page is slow. */
	moderateMs: { value: 1500, min: 200, max: 30_000, unit: "ms", rules: ["response_moderate"] },
	/** HTML size past which a page is heavy (Googlebot reads 2 MB of a file). */
	pageKb: { value: 1024, min: 100, max: 2048, unit: "kb", rules: ["page_moderate"] },
	/** Redirect hops from which a chain is filed. */
	redirectHops: { value: 2, min: 2, max: 10, unit: "hops", rules: ["redirect_chain"] },
	/** URL length past which a URL is very long. */
	urlMaxChars: { value: 200, min: 50, max: 2000, unit: "chars", rules: ["url_too_long"] },
	/** Clicks from the home page past which a page is deep. */
	deepClicks: { value: 4, min: 2, max: 20, unit: "clicks", rules: ["deep_page"] },
	/** The weight an image may have. */
	imageKb: { value: 100, min: 10, max: 5000, unit: "kb", rules: ["image_too_large"] }
} as const satisfies Record<string, SeoAuditThresholdSpec>;

/** A threshold's key. */
export type SeoAuditThresholdKey = keyof typeof SEO_AUDIT_THRESHOLD_SPECS;

/** Every threshold's value: what the audit judges with. */
export type SeoAuditThresholdValues = Record<SeoAuditThresholdKey, number>;

/** The keys, in the order the form lists them. */
export const SEO_AUDIT_THRESHOLD_KEYS = Object.keys(
	SEO_AUDIT_THRESHOLD_SPECS
) as readonly SeoAuditThresholdKey[];

/** The tuned defaults. */
export const SEO_AUDIT_THRESHOLD_DEFAULTS: Readonly<SeoAuditThresholdValues> = Object.fromEntries(
	SEO_AUDIT_THRESHOLD_KEYS.map((key) => [key, SEO_AUDIT_THRESHOLD_SPECS[key].value])
) as SeoAuditThresholdValues;

/** The pairs whose lower bound must stay under the upper one. */
const ORDERED_PAIRS: readonly (readonly [SeoAuditThresholdKey, SeoAuditThresholdKey])[] = [
	["titleMinPx", "titleMaxPx"],
	["descriptionMinPx", "descriptionMaxPx"],
	["moderateMs", "slowMs"]
];

/**
 * Whether a key names a threshold a project may change.
 *
 * @param key - The key.
 * @returns Whether it does.
 */
export function isSeoAuditThresholdKey(key: string): key is SeoAuditThresholdKey {
	return Object.hasOwn(SEO_AUDIT_THRESHOLD_SPECS, key);
}

/**
 * The thresholds a project changed, read from stored JSON: only known keys whose value is a finite
 * number within its range and differs from the default; a pair left out of order is dropped whole.
 *
 * @param value - The stored value.
 * @returns The changed thresholds.
 */
export function customThresholdsOf(value: unknown): Partial<SeoAuditThresholdValues> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const kept: Partial<SeoAuditThresholdValues> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!isSeoAuditThresholdKey(key) || typeof raw !== "number" || !Number.isFinite(raw)) continue;
		const spec = SEO_AUDIT_THRESHOLD_SPECS[key];
		if (raw < spec.min || raw > spec.max || raw === spec.value) continue;
		kept[key] = raw;
	}
	for (const [low, high] of ORDERED_PAIRS) {
		const values = auditThresholdsOf(kept);
		if (values[low] >= values[high]) {
			delete kept[low];
			delete kept[high];
		}
	}
	return kept;
}

/**
 * Why a set of changed thresholds cannot be saved, or null when it can: a lower bound at or over its
 * upper one (the defaults fill the keys left out).
 *
 * @param custom - The changed thresholds, each within its range.
 * @returns The first pair out of order, or null.
 */
export function thresholdOrderProblem(
	custom: Partial<SeoAuditThresholdValues>
): readonly [SeoAuditThresholdKey, SeoAuditThresholdKey] | null {
	const values = auditThresholdsOf(custom);
	return ORDERED_PAIRS.find(([low, high]) => values[low] >= values[high]) ?? null;
}

/**
 * Every threshold the audit judges with: the project's own where it changed one, else the default.
 *
 * @param custom - The changed thresholds, if any.
 * @returns The values.
 */
export function auditThresholdsOf(
	custom: Partial<SeoAuditThresholdValues> | null | undefined
): SeoAuditThresholdValues {
	return { ...SEO_AUDIT_THRESHOLD_DEFAULTS, ...custom };
}

/**
 * The checks a set of changed thresholds judges: their findings are marked custom.
 *
 * @param keys - The thresholds changed.
 * @returns The rule ids.
 */
export function customThresholdRules(keys: Iterable<string>): Set<SeoAuditRuleId> {
	const rules = new Set<SeoAuditRuleId>();
	for (const key of keys) {
		if (!isSeoAuditThresholdKey(key)) continue;
		for (const ruleId of SEO_AUDIT_THRESHOLD_SPECS[key].rules) rules.add(ruleId);
	}
	return rules;
}
