import type { SeoApi } from "./api.js";
import { isNamedProject, listCrawlProjects } from "./projects.js";
import { saveCrawl } from "./save.js";
import type { SaveReader, SaveResult } from "./save.js";

/**
 * `seostudio agent`: the crawler of the projects set to run their scheduled crawls on your own server.
 * It crawls only the projects its owner named (`--project`, or `SEOSTUDIO_PROJECTS`), never every
 * project the key can reach: a project another member set up must not make this machine read its
 * site. Every pass it asks SEOStudio which of the named projects are due, then crawls each one over
 * the saved-crawl steps (`./save`), one at a time, from this machine's network. Between
 * passes it waits. A project whose crawl failed waits {@link FAILED_RETRY_MS} before it is tried
 * again, so a site that is down is not knocked on every pass. It logs one line per crawl and never the
 * API key.
 */

/** How long a project whose crawl failed waits before this agent tries it again. */
export const FAILED_RETRY_MS = 60 * 60 * 1000;

/** What the agent is handed. */
export interface AgentOptions {
	api: SeoApi;
	reader: SaveReader;
	/** The projects this agent crawls: ids or site domains; never empty. */
	projects: readonly string[];
	/** Run one pass and end (for a cron job). */
	once: boolean;
	intervalMinutes: number;
	/** Writes one log line. */
	log: (line: string) => void;
	now?: () => number;
	/** Waits between passes; resolves early once a stop is asked for. */
	wait: (ms: number) => Promise<void>;
	/** Whether a stop was asked for (SIGTERM, Ctrl+C). */
	stopRequested: () => boolean;
}

/**
 * One crawl's outcome as a log line.
 *
 * @param name - The project.
 * @param result - How the crawl ended.
 * @returns The line.
 */
export function crawlLogLine(name: string, result: SaveResult): string {
	if (!result.ok) return `${name}: not crawled (${result.code}). ${result.error}`;
	const parts = [`${String(result.checked)} pages checked`];
	if (result.auditQueued) parts.push("audit queued");
	else {
		if (result.healthScore !== null) parts.push(`health ${String(result.healthScore)}`);
		if (result.open !== null) parts.push(`${String(result.open)} issues open`);
	}
	if (result.capped) parts.push("stopped at your plan's pages per run");
	return `${name}: ${parts.join(", ")}.`;
}

/**
 * Runs the agent until it is stopped (or after one pass with `once`).
 *
 * @param options - The API, the reader, the pace and the log.
 * @returns The exit code: 0, 1 when the API key cannot be used, 2 when no project was named.
 */
export async function runAgent(options: AgentOptions): Promise<number> {
	const now = options.now ?? Date.now;
	const failedAt = new Map<string, number>();
	const stamp = (): string => new Date(now()).toISOString();
	if (options.projects.length === 0) {
		options.log("Name the projects this agent crawls with --project <id> or SEOSTUDIO_PROJECTS.");
		return 2;
	}
	options.log(
		`[${stamp()}] seostudio agent started for ${options.projects.join(", ")}; checking for due crawls every ${String(options.intervalMinutes)} minutes.`
	);
	let warned = false;
	for (;;) {
		const listed = await listCrawlProjects(options.api);
		if (!listed.ok) {
			options.log(`[${stamp()}] ${listed.error}`);
			if (listed.code === "signed_out" || listed.code === "forbidden") return 1;
		} else {
			const named = listed.projects.filter((project) =>
				options.projects.some((reference) => isNamedProject(project, reference))
			);
			if (!warned) {
				warned = true;
				for (const reference of options.projects) {
					if (!named.some((project) => isNamedProject(project, reference))) {
						options.log(`[${stamp()}] No project ${reference} for this API key.`);
					}
				}
				for (const project of named) {
					if (project.runner !== "own_server") {
						options.log(
							`[${stamp()}] ${project.urlHost ?? project.name} runs its crawls on SEOStudio's servers. To run them here, switch on "Run on your own server" in its site audit settings.`
						);
					}
				}
			}
			const due = named.filter((project) => {
				const failed = failedAt.get(project.id);
				return project.due && (failed === undefined || now() - failed >= FAILED_RETRY_MS);
			});
			for (const project of due) {
				if (options.stopRequested()) break;
				const name = project.urlHost ?? project.name;
				options.log(`[${stamp()}] ${name}: crawling.`);
				if (project.urlHost === null) continue;
				const result = await saveCrawl({
					projectId: project.id,
					siteHost: project.urlHost,
					api: options.api,
					reader: options.reader,
					now,
					stopRequested: options.stopRequested
				});
				if (result.ok) failedAt.delete(project.id);
				else failedAt.set(project.id, now());
				options.log(`[${stamp()}] ${crawlLogLine(name, result)}`);
				if (!result.ok && result.code === "signed_out") return 1;
			}
		}
		if (options.once || options.stopRequested()) return 0;
		await options.wait(options.intervalMinutes * 60_000);
		if (options.stopRequested()) return 0;
	}
}
