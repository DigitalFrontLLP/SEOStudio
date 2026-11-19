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
import { computerReadOptions } from "@seostudio/audit-engine/discovery";
import { readResources } from "@seostudio/audit-engine/resource-check";
import type { SeoResourceCheckTarget } from "@seostudio/audit-engine/resource-check";
import type { SeoPageRenderer } from "@seostudio/audit-engine/types";

import { guardedFetch } from "@seostudio/audit-engine";
import type { SaveReader } from "./save.js";

/**
 * THE AUDIT ENGINE AS A SAVED CRAWL'S READER: the same plan, page and file reads the desktop app makes,
 * with the desktop's read options (`computerReadOptions`), every request through the engine's address
 * guard (`guardedFetch`: no private, local or metadata address, each redirect hop checked again, the
 * connection pinned). Pages are rendered when a browser is lent, else read as raw HTML.
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
 * @param render - The browser each page is rendered in, or undefined to read raw HTML only.
 * @returns The reader.
 */
export function engineReader(render?: SeoPageRenderer): SaveReader {
	const deps: SeoReadDeps = {
		fetch: guardedFetch,
		now: () => new Date(),
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		...(render === undefined ? {} : { render })
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
				...computerReadOptions({ device: input.device, renderWaitMs: input.renderWaitMs }),
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
