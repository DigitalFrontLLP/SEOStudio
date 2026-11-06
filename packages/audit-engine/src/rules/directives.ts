import type { SeoPageRobotsGroup } from "../facts";

import { finding, htmlSnapshot } from "./page-state";
import type { AuditFinding, AuditPage } from "./types";

/**
 * THE ROBOTS DIRECTIVE RULES beyond noindex and nofollow (`./indexing`): every token of every robots
 * meta tag and `X-Robots-Tag` header, per crawler it addresses (`robots` for all of them).
 *
 * Meta tags are read from the page as stored (the rendered DOM whenever the browser rendered it), and
 * only the ones in `<head>`: one in `<body>` is ignored by search engines and filed by `./head`.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - meta and header disagree only when one forbids what the other EXPLICITLY allows (`noindex`
 *   against `index` or `all`); a directive one source leaves out is no disagreement;
 * - a snippet restriction is filed only on a page that may be indexed (on a noindex page it has no
 *   effect), and `max-snippet:-1` or a positive length restricts nothing;
 * - an `unavailable_after` date is judged only when it reads as a date, against the read's own time.
 */

/** The crawlers whose directives decide how Google and Bing show a page. */
const SEARCH_AGENTS = new Set(["robots", "googlebot", "bingbot"]);

/** The directives that keep a page out of snippets, image results or translation. */
const RESTRICTING = new Set([
	"nosnippet",
	"max-snippet:0",
	"max-image-preview:none",
	"noimageindex",
	"notranslate"
]);

/** One crawler's tokens from one source. */
interface Directives {
	agent: string;
	tokens: string[];
}

/**
 * The page's directive groups from its head meta tags and its header.
 *
 * @param page - The page.
 * @returns The meta groups and the header groups.
 */
function sourcesOf(page: AuditPage): { meta: Directives[]; header: Directives[] } {
	const meta = (page.facts?.markup?.robots ?? []).filter((group) => group.inHead);
	const header: SeoPageRobotsGroup[] = page.facts?.robotsHeader ?? [];
	return { meta, header };
}

/**
 * Whether a list of tokens forbids indexing, allows it explicitly, or says nothing.
 *
 * @param tokens - The tokens.
 * @param forbid - The tokens that forbid (`noindex` or `nofollow`).
 * @param allow - The tokens that allow explicitly (`index` or `follow`).
 * @returns `forbid`, `allow` or null.
 */
function stance(
	tokens: readonly string[],
	forbid: string,
	allow: string
): "forbid" | "allow" | null {
	if (tokens.includes(forbid) || tokens.includes("none")) return "forbid";
	if (tokens.includes(allow) || tokens.includes("all")) return "allow";
	return null;
}

/**
 * The tokens of one crawler across groups.
 *
 * @param groups - The groups.
 * @param agent - The crawler.
 * @returns Its tokens.
 */
function tokensFor(groups: readonly Directives[], agent: string): string[] {
	return groups.filter((group) => group.agent === agent).flatMap((group) => group.tokens);
}

/**
 * The directive findings of one page.
 *
 * @param page - The page.
 * @returns Its findings.
 */
export function directiveFindings(page: AuditPage): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null || snapshot.mode === "rendered" || page.facts == null) return [];
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const { meta, header } = sourcesOf(page);
	const all = [...meta, ...header];

	const agents = [...new Set(meta.map((group) => group.agent))].filter((agent) =>
		header.some((group) => group.agent === agent)
	);
	for (const agent of agents) {
		const metaTokens = tokensFor(meta, agent);
		const headerTokens = tokensFor(header, agent);
		const conflict = (
			[
				["noindex", "index"],
				["nofollow", "follow"]
			] as const
		).find(([forbid, allow]) => {
			const one = stance(metaTokens, forbid, allow);
			const other = stance(headerTokens, forbid, allow);
			return one !== null && other !== null && one !== other;
		});
		if (conflict !== undefined) {
			found.push(
				finding(key, "directives_mismatch", {
					agent,
					meta: metaTokens.join(", "),
					header: headerTokens.join(", ")
				})
			);
			break;
		}
	}

	const repeated = new Set<string>();
	for (const agent of new Set(all.map((group) => group.agent))) {
		const seen = new Set<string>();
		for (const token of tokensFor(all, agent)) {
			if (seen.has(token)) repeated.add(agent === "robots" ? token : `${agent}: ${token}`);
			seen.add(token);
		}
	}
	if (repeated.size > 0) {
		found.push(finding(key, "directives_duplicated", { directives: [...repeated] }));
	}

	const search = all.filter((group) => SEARCH_AGENTS.has(group.agent));
	const noindex = search.some((group) => stance(group.tokens, "noindex", "index") === "forbid");
	if (!noindex) {
		const restricting = [
			...new Set(search.flatMap((group) => group.tokens).filter((token) => RESTRICTING.has(token)))
		];
		if (restricting.length > 0) {
			found.push(
				finding(key, "search_features_restricted", {
					directives: restricting,
					directive: restricting[0]
				})
			);
		}
	}

	const readAt = Date.parse(page.facts.readAt);
	const expired = search
		.flatMap((group) => group.tokens)
		.filter((token) => token.startsWith("unavailable_after:"))
		.map((token) => token.slice("unavailable_after:".length).trim())
		.find((value) => {
			const at = Date.parse(value);
			return Number.isFinite(at) && Number.isFinite(readAt) && at < readAt;
		});
	if (expired !== undefined) {
		found.push(finding(key, "unavailable_after_passed", { date: expired }));
	}
	return found;
}
