import { seoCrawlerLimits } from "../config";

import { SEO_AUDIT_RULES } from "../catalog";
import { directivesNoindex } from "../robots";
import { familyStates, idFamilyOf, inNoindexFamily } from "../segments";
import { AUDIT_EXAMPLES } from "./page-state";
import type { AuditContext, AuditFinding } from "./types";

/**
 * A NOINDEX FAMILY'S FINDINGS, FILED ONCE PER CHECK: the crawl reads a rotating sample of a family of
 * id pages that all say `noindex` (`../segments`), so what the sample shows is a fact of the family's
 * template, not of each page. Every page check found on pages of such a family is filed once, on the
 * first of them, with the family's pattern, how many of the pages checked show it and a few of them
 * (`family`): "server errors on 4 of 25 checked pages of /orders/{id}". The health score then counts
 * the family once for that check, as it counts one page with it.
 */

/** Where a family finding came from: the family, and how many of its checked pages show it. */
export interface SeoFamilyFindingParams {
	/** The family's pattern (`host/orders/{id}`). */
	pattern: string;
	/** Pages of the family that show it. */
	pages: number;
	/** Pages of the family the crawl has read (any answer). */
	of: number;
	/** A few other pages that show it. */
	examples: string[];
}

/**
 * The findings with each noindex family's page checks filed once per family and check.
 *
 * @param findings - The settled findings.
 * @param context - The audit.
 * @returns The findings, those on noindex families folded.
 */
export function foldFamilyFindings(
	findings: readonly AuditFinding[],
	context: AuditContext
): AuditFinding[] {
	const states = familyStates(
		context.pages.map((page) => ({
			pageKey: page.pageKey,
			fetched: page.status !== null && page.status >= 200 && page.status < 300,
			noindex: directivesNoindex(page.snapshot?.metaRobots, page.snapshot?.xRobotsTag),
			lastCrawledAt: null
		})),
		null
	);
	const judge = seoCrawlerLimits.noindexFamilySample;
	const groups = new Map<string, AuditFinding[]>();
	for (const entry of findings) {
		if (SEO_AUDIT_RULES[entry.ruleId].scope !== "page") continue;
		if (!inNoindexFamily(states, judge, entry.pageKey)) continue;
		const key = `${idFamilyOf(entry.pageKey) ?? ""}\u0000${entry.ruleId}`;
		const list = groups.get(key) ?? [];
		list.push(entry);
		groups.set(key, list);
	}
	if (groups.size === 0) return [...findings];
	const checked = new Map<string, number>();
	for (const page of context.pages) {
		const family = idFamilyOf(page.pageKey);
		if (family === null || page.status === null) continue;
		checked.set(family, (checked.get(family) ?? 0) + 1);
	}
	const replaced = new Map<AuditFinding, AuditFinding | null>();
	for (const [key, group] of groups) {
		const pattern = key.slice(0, key.indexOf("\u0000"));
		const sorted = [...group].sort((a, b) => a.pageKey.localeCompare(b.pageKey));
		const chosen = sorted[0];
		if (chosen === undefined) continue;
		const family: SeoFamilyFindingParams = {
			pattern,
			pages: sorted.length,
			of: Math.max(checked.get(pattern) ?? 0, sorted.length),
			examples: sorted.slice(1, AUDIT_EXAMPLES + 1).map((entry) => entry.pageKey)
		};
		for (const entry of group) replaced.set(entry, null);
		replaced.set(chosen, { ...chosen, params: { ...chosen.params, family } });
	}
	return findings.flatMap((entry) => {
		if (!replaced.has(entry)) return [entry];
		const next = replaced.get(entry);
		return next == null ? [] : [next];
	});
}
