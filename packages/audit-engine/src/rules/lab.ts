import type { SeoLabAudit } from "../facts";

import type { SeoAuditRuleId } from "../catalog";
import { AUDIT_EXAMPLES, finding, htmlSnapshot } from "./page-state";
import { pageLazyMainImage } from "./performance";
import type { AuditContext, AuditFinding, AuditLabRun, AuditPage } from "./types";

/**
 * THE LAB PERFORMANCE RULES (`lh_*`): what Lighthouse found when PageSpeed Insights tested the page, on
 * a phone (else on a desktop when only that test is held). Each is Lighthouse's own verdict, with its
 * estimated saving; the rules add what keeps them precise.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a saving audit fires only when Lighthouse estimated a metric gain (its score 0); a pattern it saw
 *   without a measurable gain (its score 0.5) is not filed;
 * - the checks other rules already make are left to them: a lazy-loaded main image
 *   (`images_lazy_hero`), the main image's fetch priority on a page the render measured
 *   (`image_lcp_priority`), images larger than their box (`image_incorrectly_sized`, which the rule
 *   runner lets stand alone when the image delivery audit names nothing else), the field Core Web Vitals (`cwv_*`), the DOM size and the page's transfer
 *   size (the rendered-DOM checks), compression and cache lifetimes (`compression_missing` and
 *   `cache_policy_weak`, judged on every page from the resource checks); no lab metric is filed
 *   against a threshold;
 * - the request chain and forced reflow audits fail on any chain or reflow at all, so they are filed
 *   only past a length that costs a good LCP, or a reflow time that costs a frame;
 * - a page that no longer answers 2xx HTML is not judged on an older test.
 *
 * SEVERITY: the catalog's, like every other check (one severity per check, wherever it is shown); the
 * estimated saving travels in the params, so a page's finding says how much is at stake.
 */

/** The thresholds the lab rules use. */
export const LAB_THRESHOLDS = {
	/** A critical request chain this long (ms) delays a good LCP (2.5 s). */
	chainMs: 2_500,
	/** Forced reflow time (ms) that costs at least a few frames. */
	reflowMs: 50,
	/** JavaScript execution time (ms) worth cutting. */
	jsExecutionMs: 2_000,
	/** Main-thread work (ms) past Lighthouse's poor mark. */
	mainThreadMs: 4_000,
	/** A mobile performance score under this is poor. */
	performanceScore: 50
} as const;

/**
 * The document latency checks other rules judge on every page: compression (`compression_missing`).
 */
const LEFT_TO_OTHER_RULES = new Set(["usesCompression"]);

/** Lighthouse's pass mark: a score under it is a failure. */
const PASS = 0.9;

/** The audits whose failure is a saving Lighthouse estimated, by rule. */
const SAVING_RULES: readonly { ruleId: SeoAuditRuleId; audits: readonly string[] }[] = [
	{ ruleId: "lh_render_blocking", audits: ["render-blocking-insight"] },
	{ ruleId: "lh_image_delivery", audits: ["image-delivery-insight"] },
	{ ruleId: "lh_legacy_javascript", audits: ["legacy-javascript-insight"] },
	{ ruleId: "lh_duplicated_javascript", audits: ["duplicated-javascript-insight"] },
	{ ruleId: "lh_unused_css", audits: ["unused-css-rules"] },
	{ ruleId: "lh_unused_javascript", audits: ["unused-javascript"] },
	{ ruleId: "lh_unminified", audits: ["unminified-css", "unminified-javascript"] },
	{ ruleId: "lh_font_display", audits: ["font-display-insight"] }
];

/**
 * Whether Lighthouse estimated a gain for a failed audit (score 0; 0.5 is a failure without one).
 *
 * @param audit - The audit.
 * @returns Whether it did.
 */
function failedWithSaving(audit: SeoLabAudit | undefined): audit is SeoLabAudit {
	return audit !== undefined && audit.score !== null && audit.score < 0.5;
}

/**
 * Whether an audit failed at all.
 *
 * @param audit - The audit.
 * @returns Whether it did.
 */
function failed(audit: SeoLabAudit | undefined): audit is SeoLabAudit {
	return audit !== undefined && audit.score !== null && audit.score < PASS;
}

/**
 * The params every lab finding carries: the device, the test's day, the saving and examples.
 *
 * @param device - The device the test emulated.
 * @param run - The test.
 * @param audits - The audits behind the finding.
 * @returns The params.
 */
function paramsOf(
	device: "mobile" | "desktop",
	run: AuditLabRun,
	audits: readonly SeoLabAudit[]
): Record<string, unknown> {
	const urls = [...new Set(audits.flatMap((audit) => audit.urls))].slice(0, AUDIT_EXAMPLES);
	const elements = [...new Set(audits.flatMap((audit) => audit.elements))].slice(0, AUDIT_EXAMPLES);
	const savingsMs = Math.max(0, ...audits.map((audit) => audit.savingsMs));
	const savingsBytes = audits.reduce((sum, audit) => sum + audit.savingsBytes, 0);
	return {
		device,
		testedOn: run.testedOn,
		savingsMs,
		savingsKb: Math.round(savingsBytes / 1024),
		...(urls.length > 0
			? { urls, urlCount: audits.reduce((sum, audit) => sum + audit.urlCount, 0) }
			: {}),
		...(elements.length > 0 ? { elements } : {})
	};
}

/**
 * The lab findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function labFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const lab = context.site.lab?.get(page.pageKey);
	if (lab === undefined || htmlSnapshot(page) === null) return [];
	const device = lab.mobile !== null ? "mobile" : "desktop";
	const run = lab.mobile ?? lab.desktop;
	if (run === null) return [];
	const key = page.pageKey;
	const t = LAB_THRESHOLDS;
	const audit = (id: string): SeoLabAudit | undefined => run.audits[id];
	const found: AuditFinding[] = [];

	for (const spec of SAVING_RULES) {
		const failing = spec.audits.map(audit).filter(failedWithSaving);
		if (failing.length === 0) continue;
		found.push(finding(key, spec.ruleId, paramsOf(device, run, failing)));
	}

	const latency = audit("document-latency-insight");
	const latencyChecks =
		latency?.failedChecks.filter((check) => !LEFT_TO_OTHER_RULES.has(check)) ?? [];
	if (failedWithSaving(latency) && latencyChecks.length > 0) {
		found.push(
			finding(key, "lh_document_latency", {
				...paramsOf(device, run, [latency]),
				checks: latencyChecks
			})
		);
	}

	const discovery = audit("lcp-discovery-insight");
	if (failed(discovery)) {
		const lazyHeroFiled = pageLazyMainImage(page) !== null;
		const probed = page.facts?.render?.dom != null;
		const checks = discovery.failedChecks.filter(
			(check) =>
				!(check === "eagerlyLoaded" && lazyHeroFiled) && !(check === "priorityHinted" && probed)
		);
		if (checks.length > 0) {
			found.push(
				finding(key, "lh_lcp_discovery", { ...paramsOf(device, run, [discovery]), checks })
			);
		}
	}

	const chain = audit("network-dependency-tree-insight");
	if (chain?.value != null && chain.value >= t.chainMs) {
		const chainMs = Math.round(chain.value);
		found.push(
			finding(key, "lh_network_dependency_tree", { ...paramsOf(device, run, [chain]), chainMs })
		);
	}

	const shifts = audit("cls-culprits-insight");
	if (failed(shifts)) {
		const cls = shifts.value === null ? null : Math.round(shifts.value * 1000) / 1000;
		found.push(
			finding(key, "lh_layout_shift_culprits", {
				...paramsOf(device, run, [shifts]),
				...(cls === null ? {} : { cls })
			})
		);
	}

	const reflow = audit("forced-reflow-insight");
	if (failed(reflow) && reflow.value !== null && reflow.value >= t.reflowMs) {
		found.push(
			finding(key, "lh_forced_reflow", {
				...paramsOf(device, run, [reflow]),
				ms: Math.round(reflow.value)
			})
		);
	}

	const bootup = audit("bootup-time");
	if (bootup?.value != null && bootup.value > t.jsExecutionMs) {
		found.push(
			finding(key, "lh_js_execution", {
				...paramsOf(device, run, [bootup]),
				ms: Math.round(bootup.value)
			})
		);
	}

	const mainThread = audit("mainthread-work-breakdown");
	if (mainThread?.value != null && mainThread.value > t.mainThreadMs) {
		found.push(
			finding(key, "lh_main_thread", {
				device,
				testedOn: run.testedOn,
				ms: Math.round(mainThread.value)
			})
		);
	}

	const score = lab.mobile?.performanceScore ?? null;
	if (lab.mobile !== null && score !== null && score < t.performanceScore) {
		found.push(
			finding(key, "lh_performance_score", {
				device: "mobile",
				testedOn: lab.mobile.testedOn,
				score
			})
		);
	}
	return found;
}
