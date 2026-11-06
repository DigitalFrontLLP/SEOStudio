import { seoCrawlerLimits } from "./config";
import type { SeoAgentFileOutcomeValue, SeoAgentFilesFacts } from "./facts";

import { decodeBody, fetchResource } from "./fetch";
import { robotsAllows } from "./robots";
import type { CompiledRobots } from "./robots";
import type { SeoCrawlFetcher } from "./types";

/**
 * THE SITE'S FILES FOR AI AGENTS, read with the plan (on the server, or on a member's computer):
 * `/llms.txt`, the agent files declared under `/.well-known/` (an API catalog, an A2A agent card, an AI
 * catalog, an MCP manifest), and whether the home page answers a request for markdown with markdown.
 * One request each, at the site's pace and within robots.txt. Only what each answered and how it reads
 * is kept; the rules (`./rules/agent-files`) judge it.
 *
 * A file the site does not have is ABSENT, never broken: a 4xx, a redirect to another page, or an HTML
 * page on a site whose catch-all answers every URL. An HTML page where the site has no catch-all is a
 * soft 404.
 */

/** The agent files asked, in order. */
export const SEO_AGENT_FILE_PATHS = [
	"/llms.txt",
	"/.well-known/api-catalog",
	"/.well-known/agent-card.json",
	"/.well-known/ai-catalog.json",
	"/.well-known/mcp.json"
] as const;

/** The most bytes of an agent file read. */
const AGENT_FILE_BYTES = 512 * 1024;

/** A markdown H1 line, and a markdown link. */
const MARKDOWN_H1 = /^#\s+\S/mu;
const MARKDOWN_LINK = /\[[^\]\n]+\]\([^)\s]+\)/u;

/** What the reads are told about the site. */
export interface SeoAgentFilesInput {
	/** The site's origin (`https://host`). */
	origin: string;
	userAgent: string;
	/** The robots.txt the crawl obeys. */
	robots: CompiledRobots;
	/**
	 * Whether the site answers 2xx for a URL that cannot exist (its catch-all page), or null when not
	 * known: an HTML answer then reads as absent.
	 */
	catchAll: boolean | null;
}

/** What the reads reach outside themselves. */
export interface SeoAgentFilesDeps {
	fetch: SeoCrawlFetcher;
	now: () => Date;
	/** Waits for the site's next turn before a request. */
	pace: (url: string) => Promise<void>;
}

/**
 * Whether an answer is an HTML page.
 *
 * @param contentType - The `Content-Type`, or null.
 * @param text - The body.
 * @returns Whether it is.
 */
function isHtml(contentType: string | null, text: string): boolean {
	return /html/iu.test(contentType ?? "") || /^\s*(?:<!doctype html|<html)/iu.test(text);
}

/**
 * How a served agent file reads.
 *
 * @param path - The file's path.
 * @param text - Its body.
 * @returns The outcome.
 */
function contentOutcome(path: string, text: string): SeoAgentFileOutcomeValue {
	if (path === "/llms.txt") {
		if (!MARKDOWN_H1.test(text)) return "no_h1";
		return MARKDOWN_LINK.test(text) ? "ok" : "no_links";
	}
	try {
		JSON.parse(text);
		return "ok";
	} catch {
		return "invalid_json";
	}
}

/**
 * Whether an answer moved off the path asked (a redirect to the home page, a login, a locale).
 *
 * @param finalUrl - Where it landed.
 * @param path - The path asked.
 * @returns Whether it moved.
 */
function moved(finalUrl: string, path: string): boolean {
	try {
		return new URL(finalUrl).pathname !== path;
	} catch {
		return true;
	}
}

/**
 * READS THE SITE'S FILES FOR AI AGENTS.
 *
 * @param input - The site, its robots.txt and whether it has a catch-all.
 * @param deps - The guarded transport, the clock and the site's pace.
 * @returns The facts.
 */
export async function readAgentFiles(
	input: SeoAgentFilesInput,
	deps: SeoAgentFilesDeps
): Promise<SeoAgentFilesFacts> {
	const read = async (url: string, accept: string) => {
		await deps.pace(url);
		return fetchResource(url, {
			fetcher: deps.fetch,
			userAgent: input.userAgent,
			accept,
			maxBytes: AGENT_FILE_BYTES,
			timeoutMs: seoCrawlerLimits.timeoutMs,
			maxRedirects: seoCrawlerLimits.maxRedirects,
			now: deps.now
		});
	};
	const files: SeoAgentFilesFacts["files"] = [];
	for (const path of SEO_AGENT_FILE_PATHS) {
		const url = `${input.origin}${path}`;
		if (!robotsAllows(input.robots, url)) continue;
		const answer = await read(url, "text/plain,application/json,*/*;q=0.5");
		const status = answer.error === null && answer.finalStatus !== 0 ? answer.finalStatus : null;
		let outcome: SeoAgentFileOutcomeValue = "absent";
		if (status !== null && status >= 500) {
			outcome = path === "/llms.txt" ? "server_error" : "absent";
		} else if (
			status !== null &&
			status >= 200 &&
			status < 300 &&
			!moved(answer.finalUrl, path) &&
			answer.body !== null
		) {
			const text = await decodeBody(answer.body, answer.contentType, AGENT_FILE_BYTES);
			if (isHtml(answer.contentType, text))
				outcome = input.catchAll === false ? "soft_404" : "absent";
			else outcome = contentOutcome(path, text);
		}
		files.push({ path, status, outcome });
	}
	const home = `${input.origin}/`;
	let markdownNegotiated = false;
	if (robotsAllows(input.robots, home)) {
		const answer = await read(home, "text/markdown");
		markdownNegotiated =
			answer.error === null &&
			answer.finalStatus >= 200 &&
			answer.finalStatus < 300 &&
			/^text\/(?:x-)?markdown/iu.test(answer.contentType ?? "");
	}
	return { checkedAt: deps.now().toISOString(), files, markdownNegotiated };
}
