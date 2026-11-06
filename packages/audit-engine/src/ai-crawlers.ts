import { compileRobots, parseRobots, robotsDecision } from "./robots";
import type { ParsedRobots } from "./robots";

/**
 * WHETHER THE SEARCH ENGINES' AND AI ASSISTANTS' CRAWLERS MAY READ A SITE, from its robots.txt: the
 * documented crawler tokens and what each is for, all read with one matcher, so every tool that asks
 * about a token gets the same answer. Pure.
 */

/**
 * What a crawler is for, as the Site audit's crawler table reports it:
 * - `search`: it indexes a page so the vendor's search or assistant can show or cite it (Googlebot and
 *   Bingbot, which every search result depends on, and the AI vendors' search crawlers). Blocking one
 *   keeps the site out of that answer.
 * - `grounding`: a control token that decides whether pages may ground an assistant's answers
 *   (`Google-Extended` for the Gemini app); a legitimate opt-out, reported and never flagged.
 * - `training`: it collects pages to train models. Blocking one has NO effect on search or citations.
 * - `user`: a fetch a person asked an assistant to make; vendors differ on whether robots.txt applies.
 */
export type SeoCrawlerPurpose = "search" | "grounding" | "training" | "user";

/** One documented crawler token, as the Site audit lists it. */
export interface SeoKnownCrawler {
	/** The robots.txt product token. */
	token: string;
	/** Who runs it. */
	owner: string;
	purpose: SeoCrawlerPurpose;
	/** Whether it is a classic search engine rather than an AI vendor. */
	engine: boolean;
}

/**
 * One documented crawler.
 *
 * @param token - Its robots.txt product token.
 * @param owner - Who runs it.
 * @param purpose - What it is for.
 * @param engine - Whether it is a classic search engine.
 * @returns The crawler.
 */
function crawler(
	token: string,
	owner: string,
	purpose: SeoCrawlerPurpose,
	engine = false
): SeoKnownCrawler {
	return { token, owner, purpose, engine };
}

/**
 * EVERY CRAWLER THE SITE AUDIT REPORTS, search engines first: the search engines', the AI assistants'
 * search crawlers, the grounding token, the user fetchers and the training crawlers.
 */
export const SEO_KNOWN_CRAWLERS: readonly SeoKnownCrawler[] = [
	crawler("Googlebot", "Google", "search", true),
	crawler("Bingbot", "Microsoft", "search", true),
	crawler("OAI-SearchBot", "OpenAI", "search"),
	crawler("Claude-SearchBot", "Anthropic", "search"),
	crawler("PerplexityBot", "Perplexity", "search"),
	crawler("Google-Extended", "Google", "grounding"),
	crawler("ChatGPT-User", "OpenAI", "user"),
	crawler("Claude-User", "Anthropic", "user"),
	crawler("Perplexity-User", "Perplexity", "user"),
	crawler("GPTBot", "OpenAI", "training"),
	crawler("ClaudeBot", "Anthropic", "training"),
	crawler("Applebot-Extended", "Apple", "training"),
	crawler("CCBot", "Common Crawl", "training")
];

/** One known crawler's access to a site, as the Site audit reads it. */
export interface SeoCrawlerAccess extends SeoKnownCrawler {
	/** Whether robots.txt lets it fetch the home page. */
	homeAllowed: boolean;
	/** How many of the checked pages it may not fetch. */
	blockedPages: number;
	/** How many pages were checked. */
	checkedPages: number;
}

/** One page a token may not fetch, and the robots.txt rule that says so. */
export interface SeoRobotsTokenBlock {
	url: string;
	/** The group the rule sits in (`*` when it is the catch-all group). */
	userAgent: string;
	/** The rule's line as written. */
	rule: string;
}

/**
 * One token read against a parsed robots.txt on every page checked.
 *
 * @param robots - The parsed file.
 * @param token - The product token.
 * @param pages - The absolute URLs, the home page first.
 * @returns Whether it may fetch the home page, and each page it may not fetch.
 */
export function robotsTokenCheck(
	robots: ParsedRobots,
	token: string,
	pages: readonly string[]
): { homeAllowed: boolean; blocked: SeoRobotsTokenBlock[] } {
	const compiled = compileRobots(robots, token);
	const blocked: SeoRobotsTokenBlock[] = [];
	let homeAllowed = true;
	pages.forEach((url, index) => {
		const decision = robotsDecision(compiled, url);
		if (decision.allowed) return;
		if (index === 0) homeAllowed = false;
		blocked.push({
			url,
			userAgent: decision.rule?.userAgent ?? "*",
			rule: decision.rule?.line ?? ""
		});
	});
	return { homeAllowed, blocked };
}

/**
 * Each known crawler's access to a site under its robots.txt, read with the same matcher as the AI
 * visibility check. PURE. A missing robots.txt ("") allows everything.
 *
 * @param robotsTxt - The site's robots.txt ("" when it has none).
 * @param pages - The absolute URLs to check, the home page first.
 * @returns One entry per known crawler, in {@link SEO_KNOWN_CRAWLERS} order.
 */
export function seoCrawlerAccess(robotsTxt: string, pages: readonly string[]): SeoCrawlerAccess[] {
	const robots = parseRobots(robotsTxt);
	return SEO_KNOWN_CRAWLERS.map((crawler) => {
		const check = robotsTokenCheck(robots, crawler.token, pages);
		return {
			...crawler,
			homeAllowed: check.homeAllowed,
			blockedPages: check.blocked.length,
			checkedPages: pages.length
		};
	});
}

/**
 * Whether robots.txt keeps a crawler off the site: the home page is disallowed, or at least half of
 * the checked pages are. A rule that only fences off a folder (an admin area, a search page) is not.
 *
 * @param access - The crawler's access.
 * @returns Whether it is kept off the site.
 */
export function seoCrawlerKeptOff(access: SeoCrawlerAccess): boolean {
	if (!access.homeAllowed) return true;
	return access.checkedPages > 0 && access.blockedPages * 2 >= access.checkedPages;
}
