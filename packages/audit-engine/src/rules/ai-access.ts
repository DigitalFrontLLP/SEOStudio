import { seoCrawlerAccess, seoCrawlerKeptOff } from "../ai-crawlers";
import type { SeoCrawlerAccess } from "../ai-crawlers";
import { crawlBlocked, finding } from "./page-state";
import type { AuditContext, AuditFinding } from "./types";

/**
 * THE CRAWLER ACCESS RULES: whether robots.txt keeps the search engines, or the crawlers AI
 * assistants cite pages from, off the site. Read with the same matcher as the AI visibility tool's
 * crawler check, so the two tools never disagree about a token.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a crawler is "kept off" only when the home page, or at least half of the checked pages, is
 *   disallowed: a rule that fences off a folder (an admin area, internal search) is not;
 * - blocking a TRAINING crawler (GPTBot, ClaudeBot, CCBot, Applebot-Extended) or the grounding token
 *   (Google-Extended) is a legitimate choice with no effect on search or citations: never flagged;
 * - user fetches are never flagged; a missing robots.txt allows everything.
 */

/** The most pages the access check reads. */
export const ACCESS_PAGES_MAX = 500;

/**
 * The URLs the access check reads: the home page first, then the crawled pages.
 *
 * @param context - The audit.
 * @returns The absolute URLs.
 */
export function accessPages(context: AuditContext): string[] {
	const home = context.site.homeKey;
	const keys = context.pages
		.filter((page) => !crawlBlocked(page) && page.pageKey !== home)
		.map((page) => page.pageKey)
		.slice(0, ACCESS_PAGES_MAX - 1);
	return [...(home === null ? [] : [home]), ...keys].map((key) => `https://${key}`);
}

/**
 * Each known crawler's access to the site, or null before robots.txt was read.
 *
 * @param context - The audit.
 * @returns The access list, or null.
 */
export function crawlerAccessOf(context: AuditContext): SeoCrawlerAccess[] | null {
	const robots = context.site.robotsTxt;
	if (robots === null || context.site.homeKey === null) return null;
	return seoCrawlerAccess(robots, accessPages(context));
}

/**
 * The crawler access findings, filed on the home page.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function aiAccessFindings(context: AuditContext): AuditFinding[] {
	const access = crawlerAccessOf(context);
	const home = context.site.homeKey;
	if (access === null || home === null) return [];
	const keptOff = access.filter(seoCrawlerKeptOff);
	const engines = keptOff.filter((crawler) => crawler.purpose === "search" && crawler.engine);
	const ai = keptOff.filter((crawler) => crawler.purpose === "search" && !crawler.engine);
	const found: AuditFinding[] = [];
	if (engines.length > 0) {
		found.push(
			finding(home, "search_engine_blocked", { bots: engines.map((crawler) => crawler.token) })
		);
	}
	if (ai.length > 0) {
		found.push(
			finding(home, "ai_search_crawlers_blocked", { bots: ai.map((crawler) => crawler.token) })
		);
	}
	return found;
}
