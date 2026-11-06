import {
	boundPlanReading,
	boundReading,
	crawlerRobots,
	readSitePage,
	readSitePlan
} from "@seostudio/audit-engine/reading";
import type {
	SeoReadDeps,
	SeoReadPageOptions,
	SeoSitePlanInput
} from "@seostudio/audit-engine/reading";
import { readResources } from "@seostudio/audit-engine/resource-check";
import type { SeoResourceCheckTarget } from "@seostudio/audit-engine/resource-check";

import { guardedFetch } from "@seostudio/audit-engine";
import type { SaveReader } from "./save.js";

/**
 * THE AUDIT ENGINE AS A SAVED CRAWL'S READER: the same plan, page and file reads the desktop app makes,
 * raw HTML only (no browser), every request through the engine's address guard (`guardedFetch`: no
 * private, local or metadata address, each redirect hop checked again, the connection pinned).
 */

/**
 * Whether a value names a site plan: an object with the site's URL and the User-Agent.
 *
 * @param value - What the server handed out.
 * @returns Whether it is a plan.
 */
function isPlanInput(value: unknown): value is SeoSitePlanInput {
	return (
		typeof value === "object" &&
		value !== null &&
		"siteUrl" in value &&
		typeof value.siteUrl === "string" &&
		"userAgent" in value &&
		typeof value.userAgent === "string"
	);
}

/** One custom search or extraction pattern, as the engine runs it. */
type CustomCheck = NonNullable<SeoReadPageOptions["customChecks"]>[number];

/**
 * Whether a value names a custom pattern: an object with its id, mode, match and pattern.
 *
 * @param value - What the server handed out.
 * @returns Whether it is one.
 */
function isCustomCheck(value: unknown): value is CustomCheck {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"mode" in value &&
		"match" in value &&
		"pattern" in value &&
		typeof value.pattern === "string"
	);
}

/**
 * Whether a value names a resource to check: an object with its URL and kind.
 *
 * @param value - What the server handed out.
 * @returns Whether it is one.
 */
function isResourceTarget(value: unknown): value is SeoResourceCheckTarget {
	return (
		typeof value === "object" &&
		value !== null &&
		"url" in value &&
		typeof value.url === "string" &&
		"kind" in value &&
		typeof value.kind === "string"
	);
}

/**
 * The engine's reader over the guarded transport.
 *
 * @returns The reader.
 */
export function engineReader(): SaveReader {
	const deps: SeoReadDeps = {
		fetch: guardedFetch,
		now: () => new Date(),
		sleep: (ms) => new Promise((done) => setTimeout(done, ms))
	};
	return {
		async readPlan(plan) {
			if (!isPlanInput(plan)) return null;
			const reading = await readSitePlan(plan, deps);
			return reading === null ? null : boundPlanReading(reading);
		},
		async readPage(input) {
			const robots =
				input.robotsTxt === null ? null : crawlerRobots(input.robotsTxt, input.robotsAgent);
			const reading = await readSitePage(input.pageKey, input.userAgent, deps, {
				robots,
				device: input.device,
				renderWaitMs: input.renderWaitMs,
				spelling: "all",
				customChecks: input.customChecks.filter(isCustomCheck)
			});
			return boundReading(reading);
		},
		async readResources(input) {
			return readResources(input.resources.filter(isResourceTarget), input.userAgent, deps, {
				delayMs: input.delayMs
			});
		}
	};
}
