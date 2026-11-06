import { seoResourceCheckLimits } from "../config";

import { bareHostOfKey, onSiteOrBelow } from "../scope";
import { AUDIT_EXAMPLES, finding, htmlSnapshot } from "./page-state";
import type { AuditFinding, AuditPage, AuditResource } from "./types";

/**
 * THE LINKED DOCUMENT RULES: the documents a page links to (a PDF, an office file), on the site or off
 * it, each checked once per site (its size from the answer, a PDF's title from its metadata).
 *
 * - `linked_documents` is an insight: the documents with their size and title, to look through;
 * - `document_broken` (warning): a document on the site's own hosts answers 404 or 410, so the link
 *   leads nowhere (a document off the site is judged by the outbound link rules);
 * - `document_large` (notice): a document of `seoResourceCheckLimits.documentLargeBytes` or more is slow
 *   to open on a phone;
 * - `document_title_missing` (notice): a PDF whose metadata holds no title shows in search results as
 *   its file name. A PDF whose title could not be told (its metadata compressed out of reach) is never
 *   filed.
 * A document robots.txt keeps the crawler from is never fetched, so never judged.
 */

/** The most documents the insight lists. */
const DOCUMENTS_SHOWN = 10;

/**
 * Whether a document's check answered it whole: no failure, a 2xx.
 *
 * @param resource - The check.
 * @returns Whether it answered.
 */
function answered(resource: AuditResource): boolean {
	return (
		resource.error === null &&
		resource.finalStatus !== null &&
		resource.finalStatus >= 200 &&
		resource.finalStatus < 300
	);
}

/**
 * The linked document findings of one page.
 *
 * @param page - The page.
 * @param resources - What it references, with the site's latest check of each.
 * @returns Its findings.
 */
export function documentFindings(
	page: AuditPage,
	resources: readonly AuditResource[]
): AuditFinding[] {
	const documents = resources.filter(
		(resource) =>
			resource.kind === "document" &&
			resource.checkedAt !== null &&
			resource.robotsAllowed !== false
	);
	if (documents.length === 0 || htmlSnapshot(page) === null) return [];
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const live = documents.filter(answered);
	if (live.length > 0) {
		found.push(
			finding(key, "linked_documents", {
				count: live.length,
				documents: live.slice(0, DOCUMENTS_SHOWN).map((resource) => ({
					url: resource.url,
					size: resource.sizeBytes,
					title: resource.title ?? null
				}))
			})
		);
	}
	const broken = documents.filter(
		(resource) =>
			resource.error === null &&
			(resource.finalStatus === 404 || resource.finalStatus === 410) &&
			onSiteOrBelow(resource.url, bareHostOfKey(key))
	);
	if (broken.length > 0) {
		found.push(
			finding(key, "document_broken", {
				count: broken.length,
				urls: broken.map((resource) => resource.url).slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	const max = seoResourceCheckLimits.documentLargeBytes;
	const large = live.filter((resource) => resource.sizeBytes !== null && resource.sizeBytes >= max);
	if (large.length > 0) {
		found.push(
			finding(key, "document_large", {
				count: large.length,
				urls: large.map((resource) => resource.url).slice(0, AUDIT_EXAMPLES),
				max
			})
		);
	}
	const untitled = live.filter((resource) => resource.title === "");
	if (untitled.length > 0) {
		found.push(
			finding(key, "document_title_missing", {
				count: untitled.length,
				urls: untitled.map((resource) => resource.url).slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	return found;
}
