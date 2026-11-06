import { outboundBroken } from "../resources";
import { AUDIT_EXAMPLES, finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditResource } from "./types";

/**
 * THE OUTBOUND LINK RULES: links to pages on other sites that are gone, and (an insight) those that
 * redirect. Read from the shared outbound-link checks (a HEAD, a GET where the HEAD failed, rechecked
 * after 30 days).
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS: a link is broken only when the other site gave a definite answer
 * (a 4xx saying the page is gone, a 5xx other than 503, or a host that does not exist in DNS) and a
 * second check confirmed it (a failure is asked again the next day; a 5xx counts only when two checks
 * on different days answered it). A 401, 403, 407, 408, 429 or 451 is that site refusing a crawler or
 * asking for a pause, a 503 is as often a bot wall as an outage, and a timeout, a network error or a
 * resolver that could not answer may pass, so none of them is ever broken.
 */

/**
 * Whether an outbound link's checks say the page is gone.
 *
 * @param resource - The link's check.
 * @returns Whether it is broken.
 */
function brokenOutbound(resource: AuditResource): boolean {
	if (resource.checkedAt === null) return false;
	const failingSince = resource.failingSince ?? null;
	return outboundBroken({
		finalStatus: resource.finalStatus,
		error: resource.error,
		failCount: resource.failCount ?? 0,
		failingSince: failingSince === null ? null : new Date(failingSince),
		checkedAt: new Date(resource.checkedAt)
	});
}

/**
 * Whether an outbound link answers through a redirect to a live page.
 *
 * @param resource - The link's check.
 * @returns Whether it redirects.
 */
function redirectedOutbound(resource: AuditResource): boolean {
	const first = resource.status;
	const last = resource.finalStatus;
	return (
		resource.error === null &&
		first !== null &&
		first >= 300 &&
		first < 400 &&
		last !== null &&
		last >= 200 &&
		last < 300
	);
}

/**
 * The outbound link findings of one page.
 *
 * @param page - The page.
 * @param resources - What it loads and links out to, with the latest check of each.
 * @param _context - The audit.
 * @returns Its findings.
 */
export function externalLinkFindings(
	page: AuditPage,
	resources: readonly AuditResource[],
	_context: AuditContext
): AuditFinding[] {
	if (htmlSnapshot(page) === null) return [];
	const links = resources.filter((resource) => resource.kind === "link");
	const found: AuditFinding[] = [];
	for (const [ruleId, test] of [
		["external_broken", brokenOutbound],
		["external_redirect", redirectedOutbound]
	] as const) {
		const urls = [...new Set(links.filter(test).map((resource) => resource.url))].sort();
		if (urls.length > 0) {
			found.push(
				finding(page.pageKey, ruleId, { count: urls.length, urls: urls.slice(0, AUDIT_EXAMPLES) })
			);
		}
	}
	return found;
}
