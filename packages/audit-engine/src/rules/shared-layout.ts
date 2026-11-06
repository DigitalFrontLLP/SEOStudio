import { SEO_AUDIT_RULES } from "../catalog";
import type { SeoAuditRuleId } from "../catalog";
import { directivesNoindex } from "../robots";
import { judgesNoindexPage } from "./noindex-checks";
import { AUDIT_EXAMPLES, htmlSnapshot, PAGE_REDIRECT_RULES } from "./page-state";
import type { AuditContext, AuditFinding, AuditSitePage } from "./types";

/**
 * ONE LAYOUT FACT, FILED ONCE: a notice or an insight that (nearly) every page of the site, or of one
 * template, carries with the same evidence comes from the shared layout, not from each page. It is
 * filed once, on one page of the group, with how many pages carry it (`shared`), instead of once per
 * page. Applied after every other settling step, to the whole-site audit only.
 *
 * - The group is the site's readable HTML pages (a page that only sends its visitor on is no reader's
 *   page, and a page that says `noindex` counts only for the checks that judge it), or the readable
 *   pages of one template; it must hold
 *   at least {@link SHARED_LAYOUT.minPages} pages, and the finding must be on more than
 *   {@link SHARED_LAYOUT.share} of them.
 * - The same evidence is the same params, measurements aside (a DOM of 1,640 elements on one page and
 *   1,643 on the next is the same layout), or for a check that lists per-page examples
 *   ({@link EVIDENCE_OF}) the same kind of problem.
 * - Errors, warnings, checks the Dashboard may recommend per page (`sure`) and the member's own checks
 *   (custom searches, snippets, AI prompts) are never folded.
 */

/** When a repeated finding is filed once. */
export const SHARED_LAYOUT = {
	/** The fewest readable pages a group holds before it is judged. */
	minPages: 10,
	/** The share of a group's pages above which a finding is the layout's. */
	share: 0.8
} as const;

/**
 * The checks whose finding on page after page is one setting of the whole site, not a fault of each
 * page: text sent uncompressed (the server's compression is off), and the files robots.txt keeps the
 * crawler from (one robots.txt rule). On more than {@link SHARED_LAYOUT}.share of the readable pages,
 * or of one template's, each is marked `once`: one fix, which the health score prices at half on each page.
 */
const SITE_SETTINGS: ReadonlySet<SeoAuditRuleId> = new Set<SeoAuditRuleId>([
	"compression_missing",
	"resources_blocked"
]);

/** The member's own checks: what each page answers is the point of them. */
const OWN_CHECKS: ReadonlySet<SeoAuditRuleId> = new Set<SeoAuditRuleId>([
	"custom_search",
	"custom_script",
	"ai_prompt"
]);

/**
 * The evidence two findings of a check share when they come from the same layout, for the checks whose
 * params hold per-page examples: the kind of problem, not the examples.
 */
const EVIDENCE_OF: ReadonlyMap<SeoAuditRuleId, (params: Record<string, unknown>) => unknown> =
	new Map<SeoAuditRuleId, (params: Record<string, unknown>) => unknown>([
		["image_alt_quality", (params) => params.kinds ?? null]
	]);

/** Where a folded finding came from: the whole site or one template, and how many pages carry it. */
export interface SharedLayoutParams {
	scope: "site" | "template";
	/** The pages of the group that carry it. */
	pages: number;
	/** The group's readable pages. */
	of: number;
	/** A few other pages that carry it. */
	examples: string[];
}

/**
 * The test of whether something the pages carry comes from the shared layout, by the same measure as
 * the folding below: the pages that carry it are more than {@link SHARED_LAYOUT}.share of the site's
 * readable pages, or of one template's, each group holding at least {@link SHARED_LAYOUT}.minPages.
 *
 * @param readable - The site's readable pages.
 * @returns The test, over the keys of the pages that carry it.
 */
export function sharedLayoutTest(
	readable: readonly AuditSitePage[]
): (keys: ReadonlySet<string>) => boolean {
	if (readable.length < SHARED_LAYOUT.minPages) return () => false;
	const templates = new Map<string, string[]>();
	for (const page of readable) {
		const id = page.templateId ?? null;
		if (id === null) continue;
		const list = templates.get(id);
		if (list === undefined) templates.set(id, [page.pageKey]);
		else list.push(page.pageKey);
	}
	const groups = [...templates.values()].filter((keys) => keys.length >= SHARED_LAYOUT.minPages);
	return (keys) => {
		if (keys.size <= SHARED_LAYOUT.minPages * SHARED_LAYOUT.share) return false;
		if (keys.size > readable.length * SHARED_LAYOUT.share) return true;
		return groups.some(
			(group) => group.filter((key) => keys.has(key)).length > group.length * SHARED_LAYOUT.share
		);
	};
}

/**
 * The pages whose latest read says `noindex`: a check that does not judge them leaves them out of the
 * pages a layout fold or a whole-site setting counts over.
 *
 * @param context - The audit.
 * @returns Their keys.
 */
function noindexedPages(context: AuditContext): Set<string> {
	return new Set(
		context.pages
			.filter((page) => directivesNoindex(page.snapshot?.metaRobots, page.snapshot?.xRobotsTag))
			.map((page) => page.pageKey)
	);
}

/**
 * Marks the findings of a whole-site setting ({@link SITE_SETTINGS}) that most pages carry with
 * `once: "setting"`: listed on every page as one fix, at half price in the health score.
 *
 * @param findings - The settled findings.
 * @param context - The audit.
 * @returns The findings, those marked.
 */
export function markSiteSettingFindings(
	findings: readonly AuditFinding[],
	context: AuditContext
): AuditFinding[] {
	const carriers = new Map<SeoAuditRuleId, Set<string>>();
	for (const entry of findings) {
		if (!SITE_SETTINGS.has(entry.ruleId)) continue;
		const keys = carriers.get(entry.ruleId) ?? new Set<string>();
		keys.add(entry.pageKey);
		carriers.set(entry.ruleId, keys);
	}
	if (carriers.size === 0) return [...findings];
	const noindexed = noindexedPages(context);
	const inLayout = sharedLayoutTest(
		context.pages.filter((page) => htmlSnapshot(page) !== null && !noindexed.has(page.pageKey))
	);
	const once = new Set([...carriers].filter(([, keys]) => inLayout(keys)).map(([id]) => id));
	if (once.size === 0) return [...findings];
	return findings.map((entry) =>
		once.has(entry.ruleId) ? { ...entry, params: { ...entry.params, once: "setting" } } : entry
	);
}

/**
 * A value as JSON with its object keys in order, so equal params give equal text.
 *
 * @param value - The value.
 * @returns The text.
 */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * A finding's params without their measurements (the numbers at the top level), so the same fact read
 * at slightly different sizes on each page is one evidence.
 *
 * @param params - The params.
 * @returns The params, numbers left out.
 */
function withoutMeasurements(params: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(params).filter(([, value]) => typeof value !== "number")
	);
}

/**
 * Whether a check may be folded.
 *
 * @param ruleId - The check.
 * @returns Whether it may.
 */
function foldable(ruleId: SeoAuditRuleId): boolean {
	const rule = SEO_AUDIT_RULES[ruleId];
	return (
		rule.scope === "page" && rule.severity === "notice" && !rule.sure && !OWN_CHECKS.has(ruleId)
	);
}

/**
 * The params of a folded finding: the chosen page's, and for a check judged by its kind of problem the
 * examples and counts of every folded page.
 *
 * @param ruleId - The check.
 * @param chosen - The finding kept.
 * @param folded - Every finding of the group.
 * @returns The params.
 */
function mergedParams(
	ruleId: SeoAuditRuleId,
	chosen: AuditFinding,
	folded: readonly AuditFinding[]
): Record<string, unknown> {
	if (!EVIDENCE_OF.has(ruleId)) return chosen.params;
	const merged: Record<string, unknown> = { ...chosen.params };
	for (const [key, value] of Object.entries(chosen.params)) {
		if (typeof value === "number" && key === "count") {
			merged[key] = folded.reduce((sum, entry) => sum + Number(entry.params[key] ?? 0), 0);
		} else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
			const union = new Set<string>();
			for (const entry of folded) {
				const list = entry.params[key];
				if (!Array.isArray(list)) continue;
				for (const item of list) if (typeof item === "string") union.add(item);
			}
			merged[key] = [...union].slice(0, Math.max(AUDIT_EXAMPLES, value.length));
		}
	}
	return merged;
}

/**
 * The page a folded finding is filed on: the home page when it carries it, else the shallowest page
 * (then the first by key).
 *
 * @param keys - The pages that carry it.
 * @param context - The audit.
 * @returns The page key.
 */
function chosenPage(keys: readonly string[], context: AuditContext): string {
	const home = context.site.homeKey;
	if (home !== null && keys.includes(home)) return home;
	const depth = (key: string): number =>
		context.byKey.get(key)?.clickDepth ?? Number.MAX_SAFE_INTEGER;
	return [...keys].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0] ?? keys[0] ?? "";
}

/** The pages a fold counts over: the readable pages, their keys and their templates. */
interface FoldBase {
	readable: AuditSitePage[];
	keys: Set<string>;
	templates: Map<string, AuditSitePage[]>;
	/** Each page of a template big enough to judge, mapped to its template. */
	templateOf: Map<string, string>;
}

/**
 * The pages a fold counts over, grouped by template.
 *
 * @param readable - The readable pages.
 * @returns The base.
 */
function foldBase(readable: AuditSitePage[]): FoldBase {
	const templates = new Map<string, AuditSitePage[]>();
	for (const page of readable) {
		const id = page.templateId ?? null;
		if (id === null) continue;
		const list = templates.get(id) ?? [];
		list.push(page);
		templates.set(id, list);
	}
	const templateOf = new Map<string, string>();
	for (const [id, pages] of templates) {
		if (pages.length < SHARED_LAYOUT.minPages) continue;
		for (const page of pages) templateOf.set(page.pageKey, id);
	}
	return { readable, keys: new Set(readable.map((page) => page.pageKey)), templates, templateOf };
}

/**
 * The findings with each layout fact filed once.
 *
 * @param findings - The settled findings.
 * @param context - The audit.
 * @returns The findings, a repeated layout fact folded into one finding per site or template.
 */
export function foldSharedLayoutFindings(
	findings: readonly AuditFinding[],
	context: AuditContext
): AuditFinding[] {
	const redirecting = new Set(
		findings.filter((entry) => PAGE_REDIRECT_RULES.has(entry.ruleId)).map((entry) => entry.pageKey)
	);
	const noindexed = noindexedPages(context);
	const readableAll = context.pages.filter(
		(page) => htmlSnapshot(page) !== null && !redirecting.has(page.pageKey)
	);
	const bases = {
		all: foldBase(readableAll),
		indexed: foldBase(readableAll.filter((page) => !noindexed.has(page.pageKey)))
	};
	const baseOf = (ruleId: SeoAuditRuleId): FoldBase =>
		judgesNoindexPage(ruleId) ? bases.all : bases.indexed;
	const groups = new Map<string, AuditFinding[]>();
	for (const entry of findings) {
		if (!foldable(entry.ruleId) || !baseOf(entry.ruleId).keys.has(entry.pageKey)) continue;
		const evidence =
			EVIDENCE_OF.get(entry.ruleId)?.(entry.params) ?? withoutMeasurements(entry.params);
		const key = `${entry.ruleId}\u0000${stableJson(evidence)}`;
		const list = groups.get(key) ?? [];
		list.push(entry);
		groups.set(key, list);
	}
	const replaced = new Map<AuditFinding, AuditFinding | null>();
	const fold = (folded: AuditFinding[], scope: "site" | "template", of: number): void => {
		const first = folded[0];
		if (first === undefined) return;
		const keys = folded.map((entry) => entry.pageKey);
		const kept = chosenPage(keys, context);
		const chosen = folded.find((entry) => entry.pageKey === kept) ?? first;
		const shared: SharedLayoutParams = {
			scope,
			pages: folded.length,
			of,
			examples: keys.filter((key) => key !== kept).slice(0, AUDIT_EXAMPLES)
		};
		for (const entry of folded) replaced.set(entry, null);
		replaced.set(chosen, {
			...chosen,
			params: { ...mergedParams(chosen.ruleId, chosen, folded), shared }
		});
	};
	for (const group of groups.values()) {
		const ruleId = group[0]?.ruleId;
		if (ruleId === undefined) continue;
		const { readable, templates, templateOf } = baseOf(ruleId);
		if (readable.length < SHARED_LAYOUT.minPages) continue;
		if (group.length > readable.length * SHARED_LAYOUT.share) {
			fold(group, "site", readable.length);
			continue;
		}
		const byTemplate = new Map<string, AuditFinding[]>();
		for (const entry of group) {
			const id = templateOf.get(entry.pageKey);
			if (id === undefined) continue;
			const list = byTemplate.get(id);
			if (list === undefined) byTemplate.set(id, [entry]);
			else list.push(entry);
		}
		for (const [id, folded] of byTemplate) {
			const size = templates.get(id)?.length ?? 0;
			if (folded.length > size * SHARED_LAYOUT.share) fold(folded, "template", size);
		}
	}
	if (replaced.size === 0) return [...findings];
	return findings.flatMap((entry) => {
		if (!replaced.has(entry)) return [entry];
		const next = replaced.get(entry);
		return next == null ? [] : [next];
	});
}
