import { z } from "zod";

import type { ApiAnswer, SeoApi } from "./api.js";
import { onProjectSite } from "./site-scope.js";

/**
 * A CRAWL SAVED TO A PROJECT: this computer reads the site and SEOStudio stores and audits what it
 * read, over the same steps the desktop app's crawl takes (open or resume the run, hand over the site's
 * plan, ask for the next pages, send numbered batches of readings, check the files the pages load,
 * finish). The server decides which pages are due, how fast to go and how many pages the plan allows;
 * this side only reads and sends. A run holds nothing the server does not: stopping mid-run leaves it
 * open, and the next start resumes it.
 *
 * What a reading looks like is the audit engine's business (`reader`); this file passes readings
 * through untouched and the server checks every one. It checks the server in turn: a page it hands
 * out must be on the project's own site (its host or a subdomain), or the run stops before reading
 * it, and every request the reader makes goes through the audit engine's address guard.
 */

/** The page readings one batch carries before it is sent. */
const BATCH_PAGES = 5;

/** The bytes of readings one batch carries before it is sent, well under the API's body limit. */
const BATCH_BYTES = 4_000_000;

/** The first pause before a call to the server is tried again; it doubles each time. */
const RETRY_FIRST_MS = 1_000;

/** The longest pause between two tries of a call. */
const RETRY_MAX_MS = 30_000;

/** How long the server may stay unreachable (a redeploy) before the run stops, left open to resume. */
export const SAVE_RETRY_WINDOW_MS = 180_000;

/** Measures a reading's size on the wire. */
const UTF8 = new TextEncoder();

/** How this computer reads the site for a saved crawl: the audit engine's page, plan and file reads. */
export interface SaveReader {
	/**
	 * Reads the site's plan (robots.txt, sitemaps, the soft-404 probe) the server asked for.
	 *
	 * @returns The plan reading to send, or null when the site could not be read at all.
	 */
	readPlan(plan: unknown): Promise<unknown>;
	/** Reads one page the server handed out. */
	readPage(input: SavePageInput): Promise<unknown>;
	/** Checks the files and outbound links the server handed out. */
	readResources(input: SaveResourcesInput): Promise<unknown[]>;
}

/** One page to read, as the server handed it out. */
export interface SavePageInput {
	/** The page key: the URL without its scheme, fetched over https. */
	pageKey: string;
	userAgent: string;
	/** The robots.txt the server's crawl obeys, or null. */
	robotsTxt: string | null;
	/** The robots.txt group that file is read for, when not the crawler's own. */
	robotsAgent: string | undefined;
	/** The project's custom search and extraction patterns. */
	customChecks: unknown[];
	device: "mobile" | "desktop";
	renderWaitMs: number;
}

/** The resources to check, as the server handed them out. */
export interface SaveResourcesInput {
	resources: unknown[];
	userAgent: string;
	/** The pause between two requests to one host. */
	delayMs: number;
}

/** Why a saved crawl did not finish. */
export type SaveFailure =
	| "signed_out"
	| "not_found"
	| "sign_in_needed"
	| "no_url"
	| "off_site"
	| "unreachable"
	| "server"
	| (string & {});

/** How a saved crawl ended. */
export type SaveResult =
	| {
			ok: true;
			runId: string;
			checked: number;
			issues: number;
			/** Whether the run reached the plan's pages per run while some were still due. */
			capped: boolean;
			/** Whether the audit was handed to a job; the counts are then null until it lands. */
			auditQueued: boolean;
			open: number | null;
			fixed: number | null;
			healthScore: number | null;
	  }
	| { ok: false; code: SaveFailure; error: string; runId: string | null };

/** What a saved crawl is told as it moves. */
export interface SaveProgress {
	phase: "starting" | "planning" | "crawling" | "resources" | "finishing";
	checked: number;
	/** Pages still due, or null before the server said. */
	left: number | null;
	issues: number;
	currentUrl: string | null;
}

/** What a saved crawl is handed. */
export interface SaveOptions {
	projectId: string;
	/** The project's host, as SEOStudio lists it: every page read must be on it or a subdomain. */
	siteHost: string;
	api: SeoApi;
	reader: SaveReader;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	onProgress?: (progress: SaveProgress) => void;
	/** Asked before each page; true stops the run after the batch in hand is sent (left open). */
	stopRequested?: () => boolean;
}

/** A refusal the server answered. */
const refusal = z.object({ ok: z.literal(false), code: z.string(), error: z.string().optional() });

/** The run's open (or resume) answer. */
const startAnswer = z.union([
	z.object({
		ok: z.literal(true),
		run: z.object({ id: z.string(), batches: z.number(), checked: z.number(), issues: z.number() }),
		plan: z.unknown(),
		site: z.object({ signInWithheld: z.boolean().optional() }).optional()
	}),
	refusal
]);

/** The plan's answer. */
const planAnswer = z.union([z.object({ ok: z.literal(true), due: z.number() }), refusal]);

/** The next pages. */
const nextAnswer = z.union([
	z.object({
		ok: z.literal(true),
		pages: z.array(z.string()),
		userAgent: z.string(),
		delayMs: z.number(),
		robotsTxt: z.string().nullable().optional(),
		robotsAgent: z.string().optional(),
		customChecks: z.array(z.unknown()).optional(),
		options: z
			.object({ device: z.enum(["mobile", "desktop"]).optional(), renderWaitMs: z.number().optional() })
			.optional(),
		remaining: z.number(),
		checked: z.number(),
		issues: z.number(),
		capped: z.boolean()
	}),
	refusal
]);

/** A batch's answer. */
const batchAnswer = z.union([
	z.object({
		ok: z.literal(true),
		stored: z.number(),
		checked: z.number(),
		issues: z.number(),
		remaining: z.number()
	}),
	refusal
]);

/** The next resources. */
const resourcesNextAnswer = z.union([
	z.object({
		ok: z.literal(true),
		resources: z.array(z.unknown()),
		userAgent: z.string(),
		delayMs: z.number()
	}),
	refusal
]);

/** The resource checks' answer. */
const resourcesAnswer = z.union([z.object({ ok: z.literal(true), stored: z.number() }), refusal]);

/** The audit's answer. */
const finishAnswer = z.union([
	z.object({
		ok: z.literal(true),
		auditQueued: z.boolean(),
		open: z.number().nullable(),
		fixed: z.number().nullable(),
		healthScore: z.number().nullable()
	}),
	refusal
]);

/** A failed step, carrying the code the run ends with. */
class SaveError extends Error {
	readonly code: SaveFailure;

	/**
	 * @param code - Why.
	 * @param message - The sentence shown.
	 */
	constructor(code: SaveFailure, message: string) {
		super(message);
		this.name = "SaveError";
		this.code = code;
	}
}

/**
 * Whether an answer may pass on its own: a 5xx, a timeout or a rate limit.
 *
 * @param status - The HTTP status.
 * @returns Whether to try again.
 */
function transient(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

/** Sentences for the failures that are not the server's own refusals. */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
	signed_out: "The API key was refused. Check it, or run `seostudio login` again.",
	not_found: "No such project for this API key.",
	sign_in_needed:
		"This site needs the sign-in saved in the project, which only the cloud crawl and the desktop app use. The run was discarded.",
	unreachable: "SEOStudio did not answer for 3 minutes. The run stays open; start again to resume it.",
	off_site:
		"SEOStudio named a page that is not on the project's site, so nothing more was read. The run stays open.",
	server: "SEOStudio answered with an error."
};

/**
 * The site a plan names, as a page key (host and path), or null when it names none.
 *
 * @param plan - The plan the server handed out.
 * @returns The key.
 */
function planSiteUrl(plan: unknown): string | null {
	if (typeof plan !== "object" || plan === null || !("siteUrl" in plan)) return null;
	const { siteUrl } = plan;
	if (typeof siteUrl !== "string") return null;
	try {
		const url = new URL(siteUrl);
		return `${url.host}${url.pathname}`;
	} catch {
		return null;
	}
}

/**
 * Runs one saved crawl of a project, from open to audit.
 *
 * @param options - The project, the API, the reader and the clock.
 * @returns How it ended.
 */
export async function saveCrawl(options: SaveOptions): Promise<SaveResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const progress: SaveProgress = {
		phase: "starting",
		checked: 0,
		left: null,
		issues: 0,
		currentUrl: null
	};
	const tell = (patch: Partial<SaveProgress>): void => {
		Object.assign(progress, patch);
		options.onProgress?.({ ...progress });
	};
	const base = `/projects/${encodeURIComponent(options.projectId)}/site-audit/local`;
	const call = async <T>(
		schema: z.ZodType<T>,
		method: "POST" | "DELETE",
		path: string,
		body?: unknown
	): Promise<T> => {
		const started = now();
		let wait = RETRY_FIRST_MS;
		for (;;) {
			let answer: ApiAnswer | null = null;
			try {
				answer = await options.api(method, path, body);
			} catch {
				answer = null;
			}
			if (answer !== null && !transient(answer.status)) {
				if (answer.status === 401) throw new SaveError("signed_out", FAILURE_TEXT.signed_out ?? "");
				if (answer.status === 404 && !refusal.safeParse(answer.body).success) {
					throw new SaveError("not_found", FAILURE_TEXT.not_found ?? "");
				}
				const parsed = schema.safeParse(answer.body);
				if (parsed.success) return parsed.data;
				throw new SaveError("server", `${FAILURE_TEXT.server ?? ""} (HTTP ${String(answer.status)})`);
			}
			const left = SAVE_RETRY_WINDOW_MS - (now() - started);
			if (left <= 0) throw new SaveError("unreachable", FAILURE_TEXT.unreachable ?? "");
			await sleep(Math.min(wait, left));
			wait = Math.min(wait * 2, RETRY_MAX_MS);
		}
	};
	const refused = (answer: z.infer<typeof refusal>): never => {
		throw new SaveError(answer.code, answer.error ?? answer.code);
	};

	let runId: string | null = null;
	try {
		const opened = await call(startAnswer, "POST", base);
		if (!opened.ok) return refused(opened);
		runId = opened.run.id;
		const runPath = `${base}/${encodeURIComponent(runId)}`;
		tell({ checked: opened.run.checked, issues: opened.run.issues });
		if (opened.site?.signInWithheld === true) {
			await call(z.unknown(), "DELETE", runPath).catch(() => null);
			throw new SaveError("sign_in_needed", FAILURE_TEXT.sign_in_needed ?? "");
		}
		let nextBatch = opened.run.batches + 1;
		if (opened.plan !== null && opened.plan !== undefined) {
			const planSite = planSiteUrl(opened.plan);
			if (planSite === null || !onProjectSite(planSite, options.siteHost)) {
				throw new SaveError("off_site", FAILURE_TEXT.off_site ?? "");
			}
			tell({ phase: "planning" });
			const reading = await options.reader.readPlan(opened.plan);
			if (reading === null) throw new SaveError("no_url", "The site could not be read.");
			const planned = await call(planAnswer, "POST", `${runPath}/plan`, reading);
			if (!planned.ok) return refused(planned);
			tell({ left: planned.due });
		}
		tell({ phase: "crawling" });
		let handedOut = "";
		let lastComplete = false;
		let lastStored = 0;
		let capped = false;
		let lastFetchAt: number | null = null;
		const pause = async (delayMs: number): Promise<void> => {
			if (lastFetchAt === null) return;
			const wait = lastFetchAt + delayMs - now();
			if (wait > 0) await sleep(wait);
		};
		for (;;) {
			if (options.stopRequested?.() === true) {
				throw new SaveError("stopped", "Stopped. The run stays open; start again to resume it.");
			}
			const next = await call(nextAnswer, "POST", `${runPath}/next`);
			if (!next.ok) return refused(next);
			tell({ left: next.remaining, checked: next.checked, issues: next.issues });
			if (next.pages.length === 0) {
				capped = next.capped;
				break;
			}
			const list = next.pages.join("\n");
			if (list === handedOut && lastComplete && lastStored === 0) break;
			handedOut = list;
			lastStored = 0;
			if (next.pages.some((pageKey) => !onProjectSite(pageKey, options.siteHost))) {
				throw new SaveError("off_site", FAILURE_TEXT.off_site ?? "");
			}
			let batch: unknown[] = [];
			let bytes = 0;
			let read = 0;
			const send = async (): Promise<void> => {
				const answer = await call(batchAnswer, "POST", `${runPath}/batch`, {
					batch: nextBatch,
					readings: batch
				});
				if (!answer.ok) refused(answer);
				else {
					nextBatch += 1;
					lastStored += answer.stored;
					tell({ checked: answer.checked, issues: answer.issues, left: answer.remaining });
				}
				batch = [];
				bytes = 0;
			};
			for (const pageKey of next.pages) {
				if (options.stopRequested?.() === true) break;
				await pause(next.delayMs);
				tell({ currentUrl: `https://${pageKey}` });
				const reading = await options.reader.readPage({
					pageKey,
					userAgent: next.userAgent,
					robotsTxt: next.robotsTxt ?? null,
					robotsAgent: next.robotsAgent,
					customChecks: next.customChecks ?? [],
					device: next.options?.device ?? "mobile",
					renderWaitMs: next.options?.renderWaitMs ?? 0
				});
				lastFetchAt = now();
				const size = UTF8.encode(JSON.stringify(reading)).byteLength;
				if (batch.length > 0 && (bytes + size > BATCH_BYTES || batch.length >= BATCH_PAGES)) {
					await send();
				}
				batch.push(reading);
				bytes += size;
				read += 1;
			}
			tell({ currentUrl: null });
			if (batch.length > 0) await send();
			lastComplete = read === next.pages.length;
		}
		tell({ phase: "resources" });
		let resourcesHandedOut = "";
		let resourcesStored: number | null = null;
		for (;;) {
			if (options.stopRequested?.() === true) {
				throw new SaveError("stopped", "Stopped. The run stays open; start again to resume it.");
			}
			const next = await call(resourcesNextAnswer, "POST", `${runPath}/resources/next`);
			if (!next.ok) return refused(next);
			if (next.resources.length === 0) break;
			const list = JSON.stringify(next.resources);
			if (list === resourcesHandedOut && resourcesStored === 0) break;
			resourcesHandedOut = list;
			await pause(next.delayMs);
			const readings = await options.reader.readResources({
				resources: next.resources,
				userAgent: next.userAgent,
				delayMs: next.delayMs
			});
			lastFetchAt = now();
			if (readings.length === 0) break;
			const stored = await call(resourcesAnswer, "POST", `${runPath}/resources`, { readings });
			if (!stored.ok) return refused(stored);
			resourcesStored = stored.stored;
		}
		tell({ phase: "finishing" });
		const done = await call(finishAnswer, "POST", `${runPath}/finish`);
		if (!done.ok) return refused(done);
		return {
			ok: true,
			runId,
			checked: progress.checked,
			issues: progress.issues,
			capped,
			auditQueued: done.auditQueued,
			open: done.open,
			fixed: done.fixed,
			healthScore: done.healthScore
		};
	} catch (error) {
		if (error instanceof SaveError) {
			return { ok: false, code: error.code, error: error.message, runId };
		}
		throw error;
	}
}
