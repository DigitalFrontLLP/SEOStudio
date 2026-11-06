import { SEO_SHARED_CDN_HOSTS } from "./config";

import { bareHost } from "./scope";

/**
 * ONE PACE PER HOST, whoever crawls it: every request the platform's crawler sends to a site first
 * takes the host's next free slot, shared across every project, payer and process (Redis on the
 * server, through a gate the host lends), so many accounts pointed at one site never multiply the rate it is asked at. A host that
 * answered 429 or 503 is backed off for every crawl of it at once. The member's own computer paces
 * itself and never takes a slot.
 *
 * A slot is a reservation: the gate answers how long the caller must wait, and moves the host's next
 * slot one interval past it, in one atomic step.
 */

/** A host's shared pace. */
export interface SeoHostGate {
	/**
	 * Reserves the host's next slot.
	 *
	 * @param host - The host, `www.` dropped.
	 * @param intervalMs - The least time between two requests to it (its robots.txt `Crawl-delay` or our floor).
	 * @param now - Now, in ms.
	 * @returns How long to wait before the request, in ms (0 when it may go now).
	 */
	reserve: (host: string, intervalMs: number, now: number) => Promise<number>;
	/**
	 * Leaves a host alone until a moment, for every crawl of it (never brings its next slot nearer).
	 *
	 * @param host - The host, `www.` dropped.
	 * @param untilMs - When it may be asked again, in ms.
	 * @param now - Now, in ms.
	 */
	backOff: (host: string, untilMs: number, now: number) => Promise<void>;
}

/**
 * The key a host's pace is kept under: the host lowercased, its `www.` and trailing dot dropped, so a
 * site's two spellings share one pace.
 *
 * @param host - The host.
 * @returns The key.
 */
export function hostGateKey(host: string): string {
	return bareHost(host);
}

/**
 * Whether a host is one of the shared CDN hosts ({@link SEO_SHARED_CDN_HOSTS}): its exact name or a
 * subdomain of one listed.
 *
 * @param host - The host.
 * @returns Whether it is.
 */
export function isSharedCdnHost(host: string): boolean {
	const name = hostGateKey(host.replace(/:\d+$/, ""));
	return SEO_SHARED_CDN_HOSTS.some((listed) => name === listed || name.endsWith(`.${listed}`));
}

/**
 * A gate held in this process's memory: the same rules as the shared one, for one process (and tests).
 *
 * @returns The gate.
 */
export function memoryHostGate(): SeoHostGate {
	const next = new Map<string, number>();
	return {
		reserve: async (host, intervalMs, now) => {
			const key = hostGateKey(host);
			const at = Math.max(now, next.get(key) ?? 0);
			next.set(key, at + intervalMs);
			return at - now;
		},
		backOff: async (host, untilMs) => {
			const key = hostGateKey(host);
			next.set(key, Math.max(next.get(key) ?? 0, untilMs));
		}
	};
}

/**
 * How long a 429 or 503 answer asks the crawler to stay away: its `Retry-After` (seconds or an HTTP
 * date), else the default, never past the ceiling.
 *
 * @param retryAfter - The header, or null.
 * @param now - Now, in ms.
 * @param defaults - The default and the ceiling, in ms.
 * @returns The pause, in ms.
 */
export function retryAfterMs(
	retryAfter: string | null,
	now: number,
	defaults: { defaultMs: number; maxMs: number }
): number {
	const value = retryAfter?.trim() ?? "";
	let asked = defaults.defaultMs;
	if (/^\d+$/.test(value)) asked = Number(value) * 1000;
	else if (value !== "" && Number.isFinite(Date.parse(value))) asked = Date.parse(value) - now;
	return Math.min(defaults.maxMs, Math.max(0, asked));
}
