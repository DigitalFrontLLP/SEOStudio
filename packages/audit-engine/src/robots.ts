/**
 * robots.txt, read the way RFC 9309 reads it: the group naming our agent token wins over `*`, the
 * longest matching rule wins inside a group, `Allow` wins a tie, and `*` and `$` are wildcards. A
 * missing or unreadable file allows everything. `Sitemap:` lines are collected wherever they sit.
 *
 * NO REGULAR EXPRESSIONS are built from the file: a rule is split on `*` once, when the file is
 * compiled for a crawl, and matched by a linear scan, so a hostile file cannot make a match
 * backtrack. The file itself is read up to {@link SEO_ROBOTS_MAX_BYTES} (Google's own limit).
 */

/** The most of a robots.txt that is read. */
export const SEO_ROBOTS_MAX_BYTES = 500 * 1024;

/** One rule of a group, as written. */
interface RobotsRule {
	allow: boolean;
	path: string;
}

/** One `User-agent` group. */
interface RobotsGroup {
	/** The `User-agent` names as written; matched case-insensitively. */
	agents: string[];
	rules: RobotsRule[];
	crawlDelaySeconds: number | null;
}

/** A parsed robots.txt. */
export interface ParsedRobots {
	groups: RobotsGroup[];
	sitemaps: string[];
}

/** One rule, split once for matching. */
interface CompiledRule {
	allow: boolean;
	/** The rule's length, which decides the longest match. */
	length: number;
	/** The rule split on `*`. */
	parts: string[];
	/** Whether the rule ends in `$`. */
	anchored: boolean;
	/** The rule as the file writes it, e.g. `Disallow: /private`. */
	line: string;
	/** The `User-agent` name of the group it came from (`*` for the catch-all group). */
	userAgent: string;
}

/** The rules that govern one agent, ready to match. */
export interface CompiledRobots {
	rules: CompiledRule[];
	/** The pause the file asks between requests, in ms, or null. */
	crawlDelayMs: number | null;
	sitemaps: string[];
}

/**
 * Parses a robots.txt body.
 *
 * @param text - The file, or null when there is none.
 * @returns The groups and the sitemap URLs.
 */
export function parseRobots(text: string | null): ParsedRobots {
	const groups: RobotsGroup[] = [];
	const sitemaps: string[] = [];
	if (text === null) return { groups, sitemaps };
	let current: RobotsGroup | null = null;
	let lastWasAgent = false;
	for (const rawLine of text.slice(0, SEO_ROBOTS_MAX_BYTES).split(/\r?\n/)) {
		const hash = rawLine.indexOf("#");
		const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
		if (line === "") continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const field = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (field === "sitemap") {
			if (value !== "") sitemaps.push(value);
			continue;
		}
		if (field === "user-agent") {
			if (current === null || !lastWasAgent) {
				current = { agents: [], rules: [], crawlDelaySeconds: null };
				groups.push(current);
			}
			current.agents.push(value);
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (current === null) continue;
		if (field === "allow" || field === "disallow") {
			if (value === "" && field === "disallow") continue;
			current.rules.push({ allow: field === "allow", path: value });
		} else if (field === "crawl-delay") {
			const seconds = Number.parseFloat(value);
			if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
		}
	}
	return { groups, sitemaps };
}

/**
 * The product token a `User-agent` value names, as Google's parser reads it: its leading letters, `_`
 * and `-`, lowercased (`Googlebot/2.1` names `googlebot`).
 *
 * @param value - The value.
 * @returns The token, or empty when it names none.
 */
function productToken(value: string): string {
	return (/^[a-z_-]+/i.exec(value.trim())?.[0] ?? "").toLowerCase();
}

/**
 * Compiles the rules that govern an agent: every group naming its product token exactly (merged), else
 * every `*` group - so `Googlebot` obeys a `Googlebot` group, never a `Googlebot-Image` or a `Google`
 * one. Done once per crawl.
 *
 * @param robots - The parsed file.
 * @param agent - The product token, e.g. `SiteSnapshot` or `Googlebot`.
 * @returns The rules, split for matching, and the crawl delay.
 */
export function compileRobots(robots: ParsedRobots, agent: string): CompiledRobots {
	const token = productToken(agent);
	const names = (name: string): boolean => {
		const named = productToken(name);
		return named !== "" && named === token;
	};
	const named = robots.groups.filter((group) => group.agents.some(names));
	const chosen =
		named.length > 0 ? named : robots.groups.filter((group) => group.agents.includes("*"));
	const delays = chosen
		.map((group) => group.crawlDelaySeconds)
		.filter((delay): delay is number => delay !== null);
	return {
		rules: chosen.flatMap((group) => {
			const userAgent = group.agents.find(names) ?? "*";
			return group.rules.map((rule) => {
				const anchored = rule.path.endsWith("$");
				return {
					allow: rule.allow,
					length: rule.path.length,
					parts: (anchored ? rule.path.slice(0, -1) : rule.path).split("*"),
					anchored,
					line: `${rule.allow ? "Allow" : "Disallow"}: ${rule.path}`,
					userAgent
				};
			});
		}),
		crawlDelayMs: delays.length > 0 ? Math.round(Math.max(...delays) * 1000) : null,
		sitemaps: robots.sitemaps
	};
}

/**
 * Whether a split rule matches a path, by a linear scan: the first part is a prefix, each later part
 * is found left to right after the previous one, and an anchored rule's last part ends the path.
 * Leftmost matching is exact for `*` wildcards, so nothing ever backtracks.
 *
 * @param rule - The compiled rule.
 * @param target - The URL's path and query.
 * @returns Whether it matches.
 */
function ruleMatches(rule: RobotsPattern, target: string): boolean {
	const { parts, anchored } = rule;
	const first = parts[0] ?? "";
	if (parts.length === 1) return anchored ? target === first : target.startsWith(first);
	if (!target.startsWith(first)) return false;
	let position = first.length;
	for (let index = 1; index < parts.length - 1; index += 1) {
		const part = parts[index] ?? "";
		if (part === "") continue;
		const found = target.indexOf(part, position);
		if (found === -1) return false;
		position = found + part.length;
	}
	const last = parts[parts.length - 1] ?? "";
	if (anchored) return target.length - last.length >= position && target.endsWith(last);
	return last === "" || target.includes(last, position);
}

/** A robots.txt-style pattern (`*` any characters, a final `$` the end), split once for matching. */
export interface RobotsPattern {
	parts: string[];
	anchored: boolean;
}

/**
 * Splits a robots.txt-style pattern for matching.
 *
 * @param pattern - The pattern, e.g. `/blog/*?page=`.
 * @returns The compiled pattern.
 */
export function compileRobotsPattern(pattern: string): RobotsPattern {
	const anchored = pattern.endsWith("$");
	return { parts: (anchored ? pattern.slice(0, -1) : pattern).split("*"), anchored };
}

/**
 * Whether a robots.txt-style pattern matches a URL's path and query, by the same linear scan the
 * robots.txt rules use (no regular expression, so no pattern is ever slow).
 *
 * @param pattern - The compiled pattern.
 * @param target - The URL's path and query.
 * @returns Whether it matches.
 */
export function robotsPatternMatches(pattern: RobotsPattern, target: string): boolean {
	return ruleMatches(pattern, target);
}

/** What robots.txt decides for one URL, and the rule that decided it. */
export interface RobotsDecision {
	allowed: boolean;
	/** The deciding rule, or null when none matched (the URL is then allowed). */
	rule: { line: string; userAgent: string } | null;
}

/**
 * What robots.txt decides for an agent and a URL: the longest matching rule, `Allow` winning a tie.
 *
 * @param robots - The compiled rules.
 * @param url - The absolute URL.
 * @returns Whether the fetch is allowed, and the rule that decided it.
 */
export function robotsDecision(robots: CompiledRobots, url: string): RobotsDecision {
	let target: string;
	try {
		const parsed = new URL(url);
		target = `${parsed.pathname}${parsed.search}`;
	} catch {
		return { allowed: false, rule: null };
	}
	if (target === "/robots.txt") return { allowed: true, rule: null };
	let best: CompiledRule | null = null;
	for (const rule of robots.rules) {
		if (!ruleMatches(rule, target)) continue;
		if (best === null || rule.length > best.length || (rule.length === best.length && rule.allow)) {
			best = rule;
		}
	}
	return {
		allowed: best === null || best.allow,
		rule: best === null ? null : { line: best.line, userAgent: best.userAgent }
	};
}

/**
 * Whether robots.txt lets the agent fetch a URL.
 *
 * @param robots - The compiled rules.
 * @param url - The absolute URL.
 * @returns Whether the fetch is allowed.
 */
export function robotsAllows(robots: CompiledRobots, url: string): boolean {
	return robotsDecision(robots, url).allowed;
}

/**
 * Whether an `X-Robots-Tag` header or a robots meta value forbids indexing.
 *
 * @param directives - The header and meta values, any of them null.
 * @returns Whether `noindex` (or `none`) is present.
 */
export function directivesNoindex(...directives: (string | null | undefined)[]): boolean {
	return directives.some(
		(value) => value !== null && value !== undefined && /\b(?:noindex|none)\b/i.test(value)
	);
}

/**
 * Whether an `X-Robots-Tag` header or a robots meta value forbids following links.
 *
 * @param directives - The header and meta values, any of them null.
 * @returns Whether `nofollow` (or `none`) is present.
 */
export function directivesNofollow(...directives: (string | null | undefined)[]): boolean {
	return directives.some(
		(value) => value !== null && value !== undefined && /\b(?:nofollow|none)\b/i.test(value)
	);
}

/** The robots.txt answers that leave a crawler unable to read the file: Google then crawls nothing. */
const ROBOTS_UNREACHABLE: ReadonlySet<string> = new Set([
	"server_error",
	"timeout",
	"redirect_loop"
]);

/**
 * Whether a robots.txt fetch outcome leaves the site unreadable for search engines: a 5xx, no answer
 * in time, or a redirect loop. A 4xx is no file, which allows everything.
 *
 * @param outcome - How robots.txt answered (`SeoRobotsFetchOutcomeValue`).
 * @returns Whether it was unreachable.
 */
export function isRobotsUnreachable(outcome: string): boolean {
	return ROBOTS_UNREACHABLE.has(outcome);
}
