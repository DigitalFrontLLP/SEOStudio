import { seoCrawlerKeptOff } from "../ai-crawlers";
import { isRobotsUnreachable, parseRobots } from "../robots";
import { crawlerAccessOf } from "./ai-access";
import { disallowedForGoogle } from "./lookups";
import { AUDIT_EXAMPLES, crawlBlocked, finding } from "./page-state";
import type { AuditContext, AuditFinding } from "./types";

/**
 * THE robots.txt FILE RULES: whether the file reads as robots.txt, what it keeps crawlers from, whether
 * it names the sitemap, and how it treats crawlers of one purpose. All whole-site, filed on the home
 * page.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a missing robots.txt allows everything and is never a syntax error; a comment, a blank line and
 *   every directive a major crawler documents (`Crawl-delay`, `Host`, `Clean-param`,
 *   `Content-Signal`, ...) are valid;
 * - the URLs robots.txt keeps crawlers from, and AI search crawlers treated differently, are
 *   insights: fencing off a folder is often deliberate; training crawlers are left out (blocking one
 *   vendor's training and not another's is a legitimate choice);
 * - a sitemap not named in robots.txt is judged only once a sitemap was read;
 * - robots.txt is unreachable only on a 5xx, a timeout or a redirect loop at two plans in a row (a
 *   4xx is no file, which allows everything).
 */

/** The robots.txt fields a major crawler documents, lowercased. */
const KNOWN_FIELDS = new Set([
	"user-agent",
	"allow",
	"disallow",
	"sitemap",
	"crawl-delay",
	"host",
	"clean-param",
	"content-signal",
	"content-usage",
	"request-rate",
	"visit-time",
	"noindex"
]);

/** The fields that only make sense inside a `User-agent` group. */
const GROUP_FIELDS = new Set(["allow", "disallow", "crawl-delay", "noindex", "clean-param"]);

/** A body that is an HTML page, not a robots.txt. */
const HTML_BODY = /^\s*<(?:!doctype\s+html|html|head|body)\b/i;

/** A `Content-Signal` line. */
const CONTENT_SIGNAL = /^[^\S\n]*content-signal[^\S\n]*:/im;

/**
 * The lines of a robots.txt a crawler cannot read: no `field: value` shape, a field no major crawler
 * documents, or a rule before any `User-agent` line.
 *
 * @param text - The file.
 * @returns Each such line with its number (1-based).
 */
export function robotsSyntaxErrors(text: string): { line: number; text: string }[] {
	const errors: { line: number; text: string }[] = [];
	let inGroup = false;
	const lines = text.split(/\r?\n/);
	for (const [index, rawLine] of lines.entries()) {
		const hash = rawLine.indexOf("#");
		const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).replace(/^\uFEFF/, "").trim();
		if (line === "") continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
		const bad = colon <= 0 || !KNOWN_FIELDS.has(field) || (GROUP_FIELDS.has(field) && !inGroup);
		if (field === "user-agent") inGroup = true;
		if (bad) errors.push({ line: index + 1, text: rawLine.trim().slice(0, 200) });
	}
	return errors;
}

/** Plans in a row robots.txt must be unreachable at before it is filed (one failed read may pass). */
const ROBOTS_UNREACHABLE_PLANS = 2;

/**
 * Whether robots.txt could be read at all, filed on the home page: a 5xx, no answer in time or a
 * redirect loop at two plans in a row (Google then crawls nothing). A 4xx is no file, which allows
 * everything, and is never filed; nor is anything before the fetch was recorded.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function robotsReachFindings(context: AuditContext): AuditFinding[] {
	const { homeKey } = context.site;
	const fetch = context.site.robotsFetch ?? null;
	if (homeKey === null || fetch === null) return [];
	if (!isRobotsUnreachable(fetch.outcome) || fetch.failures < ROBOTS_UNREACHABLE_PLANS) return [];
	return [finding(homeKey, "robots_unreachable", { outcome: fetch.outcome, status: fetch.status })];
}

/**
 * The robots.txt file findings, filed on the home page.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function robotsFileFindings(context: AuditContext): AuditFinding[] {
	const { homeKey, robotsTxt, sitemapRead } = context.site;
	if (homeKey === null || robotsTxt === null) return [];
	const found: AuditFinding[] = [];
	const present = robotsTxt.trim() !== "";
	if (present) {
		if (HTML_BODY.test(robotsTxt)) {
			found.push(finding(homeKey, "robots_syntax_error", { kind: "html", count: 1 }));
		} else {
			const errors = robotsSyntaxErrors(robotsTxt);
			if (errors.length > 0) {
				found.push(
					finding(homeKey, "robots_syntax_error", {
						kind: "lines",
						count: errors.length,
						lines: errors.slice(0, AUDIT_EXAMPLES)
					})
				);
			}
		}
		if (!CONTENT_SIGNAL.test(robotsTxt)) found.push(finding(homeKey, "content_signal_missing"));
	}
	if (sitemapRead === true && parseRobots(robotsTxt).sitemaps.length === 0) {
		found.push(finding(homeKey, "sitemap_not_in_robots"));
	}

	const blocked = new Set((context.site.robotsBlocked ?? []).map((entry) => entry.pageKey));
	for (const page of context.pages) {
		if (!crawlBlocked(page) && disallowedForGoogle(page.pageKey, context.site)) {
			blocked.add(page.pageKey);
		}
	}
	if (blocked.size > 0) {
		found.push(
			finding(homeKey, "robots_blocked_url", {
				count: blocked.size,
				urls: [...blocked].slice(0, AUDIT_EXAMPLES)
			})
		);
	}

	const access = crawlerAccessOf(context);
	if (access !== null) {
		const groups: Record<string, typeof access> = {
			ai_search: access.filter((crawler) => crawler.purpose === "search" && !crawler.engine)
		};
		const mixed = Object.entries(groups).filter(([, crawlers]) => {
			const kept = crawlers.filter(seoCrawlerKeptOff).length;
			return kept > 0 && kept < crawlers.length;
		});
		if (mixed.length > 0) {
			const crawlers = mixed.flatMap(([, list]) => list);
			found.push(
				finding(homeKey, "ai_bots_inconsistent", {
					purposes: mixed.map(([purpose]) => purpose),
					blocked: crawlers.filter(seoCrawlerKeptOff).map((crawler) => crawler.token),
					allowed: crawlers
						.filter((crawler) => !seoCrawlerKeptOff(crawler))
						.map((crawler) => crawler.token)
				})
			);
		}
	}
	return found;
}
