import { finding, indexableSnapshot } from "./page-state";
import type { AuditContext, AuditFinding } from "./types";

/**
 * THE ANALYTICS TAG INSIGHT: a page that counts each visit twice (the same Google Analytics id
 * configured twice by inline code, a config that sends no page view aside, or the same Tag Manager
 * container loaded twice; a `gtag.js` loader that Tag Manager or gtag.js loads again for an id it
 * already set up, and Tag Manager's own reload of its container (its `gtm=` parameter in the loader),
 * are normal and never filed), and a
 * page without any such tag on a site whose pages mostly load one (its visits are never counted). Read
 * from the rendered page's markup; an insight, never an issue.
 *
 * TUNED TO FLAG ONLY REAL GAPS: a site that uses no Google tag, or only on a few pages (another
 * analytics tool, or a tag on purpose on some pages only), is never asked for one; the missing tag is
 * judged only once at least {@link ANALYTICS_THRESHOLDS}.minPages pages were read and at least
 * {@link ANALYTICS_THRESHOLDS}.siteShare of them load a tag. Only pages search engines are asked to
 * show are judged.
 */

/** The thresholds of this insight. */
export const ANALYTICS_THRESHOLDS = {
	/** The fewest pages read before a missing tag is judged. */
	minPages: 5,
	/** The share of pages loading a tag from which a page without one stands out. */
	siteShare: 0.8
} as const;

/**
 * The analytics tag findings of the site.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function analyticsFindings(context: AuditContext): AuditFinding[] {
	const read: { pageKey: string; ids: string[]; duplicates: string[] }[] = [];
	for (const page of context.pages) {
		const analytics = page.facts?.markup?.analytics;
		if (analytics == null || indexableSnapshot(page, context) === null) continue;
		read.push({ pageKey: page.pageKey, ids: analytics.ids, duplicates: analytics.duplicates });
	}
	const t = ANALYTICS_THRESHOLDS;
	const tagged = read.filter((entry) => entry.ids.length > 0).length;
	const judgeMissing = read.length >= t.minPages && tagged >= read.length * t.siteShare;
	const found: AuditFinding[] = [];
	for (const entry of read) {
		if (entry.duplicates.length > 0) {
			found.push(
				finding(entry.pageKey, "analytics_tags", { kind: "duplicate", codes: entry.duplicates })
			);
		} else if (judgeMissing && entry.ids.length === 0) {
			found.push(finding(entry.pageKey, "analytics_tags", { kind: "missing" }));
		}
	}
	return found;
}
