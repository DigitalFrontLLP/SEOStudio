import type { SeoHostProbe } from "../facts";

import { bareHost } from "../scope";
import { finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding } from "./types";

/**
 * THE HOST VARIANT RULES, read from the server's own status reads at the last plan (each URL asked
 * once, never followed): whether every version of the home page (http and https, with and without
 * `www.`) ends on the one the crawl reads, and whether pages also answer over plain http.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - judged only once the home page the crawl reads answered over https, on the site's own host or its
 *   `www.` twin, so the main address is known;
 * - a version that does not exist (no DNS for `www.`), cannot be reached, or answers an error is never
 *   flagged; nor is one whose redirect leaves the versions read (where it lands was not read);
 * - a version is flagged when it answers a page itself, when its redirects end on another version that
 *   does, or when they loop; one that answers a page naming the main address as its canonical (read on
 *   https only) is a notice of its own (`host_variants_canonicalised`): search engines consolidate it;
 * - a page over plain http is flagged only when it answers a page there and the crawl read the same
 *   page over https.
 */

/** Why a version of the home page does not end on the main one. */
type VariantProblem = "answers" | "elsewhere" | "loop";

/**
 * The origin of a URL.
 *
 * @param url - The URL.
 * @returns Its origin, or null.
 */
function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/**
 * Whether an answer is a page.
 *
 * @param probe - The read.
 * @returns Whether it answered 2xx.
 */
function answersPage(probe: SeoHostProbe): boolean {
	return probe.error === null && probe.status !== null && probe.status >= 200 && probe.status < 300;
}

/**
 * Where a version of the home page ends, through the redirects among the versions read.
 *
 * @param start - The version.
 * @param byUrl - Every version read, by URL.
 * @param main - The main address's origin.
 * @returns The problem, or null when it ends on the main one or cannot be told.
 */
function variantProblem(
	start: SeoHostProbe,
	byUrl: ReadonlyMap<string, SeoHostProbe>,
	main: string
): VariantProblem | null {
	const seen = new Set<string>();
	let current = start;
	for (;;) {
		if (seen.has(current.url)) return "loop";
		seen.add(current.url);
		if (answersPage(current)) {
			if (originOf(current.url) === main) return null;
			return current === start ? "answers" : "elsewhere";
		}
		if (current.error !== null || current.status === null) return null;
		if (current.status < 300 || current.status >= 400 || current.location === null) return null;
		const next = byUrl.get(current.location);
		if (next === undefined) return null;
		current = next;
	}
}

/**
 * The main address the crawl reads: the origin the home page lands on, when it answered a page over
 * https on the site's own host or its `www.` twin.
 *
 * @param context - The audit.
 * @returns The origin and the home page's key, or null.
 */
function mainAddress(context: AuditContext): { origin: string; homeKey: string } | null {
	const homeKey = context.site.homeKey;
	if (homeKey === null) return null;
	const landing = context.resolve(homeKey);
	const home = context.byKey.get(landing);
	if (home === undefined || htmlSnapshot(home) === null) return null;
	const host = landing.split("/")[0] ?? "";
	if (host === "" || bareHost(host) !== bareHost(homeKey.split("/")[0] ?? "")) return null;
	return { origin: `https://${host}`, homeKey };
}

/**
 * The host variant finding, filed on the home page.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function hostVariantFindings(context: AuditContext): AuditFinding[] {
	const probes = context.site.hostProbes ?? null;
	const main = mainAddress(context);
	if (probes === null || main === null) return [];
	const byUrl = new Map(probes.variants.map((probe) => [probe.url, probe]));
	const flagged = probes.variants.flatMap((probe) => {
		if (originOf(probe.url) === main.origin) return [];
		const problem = variantProblem(probe, byUrl, main.origin);
		if (problem === null) return [];
		const canonical =
			problem === "answers" && probe.canonical != null && originOf(probe.canonical) === main.origin
				? probe.canonical
				: null;
		return [
			{
				url: probe.url,
				problem,
				status: probe.status,
				location: probe.location,
				...(canonical === null ? {} : { canonical })
			}
		];
	});
	const pointing = flagged.filter((variant) => "canonical" in variant);
	const plain = flagged.filter((variant) => !("canonical" in variant));
	return [
		...(plain.length === 0
			? []
			: [
					finding(main.homeKey, "host_variants_not_redirecting", {
						count: plain.length,
						variants: plain
					})
				]),
		...(pointing.length === 0
			? []
			: [
					finding(main.homeKey, "host_variants_canonicalised", {
						count: pointing.length,
						variants: pointing
					})
				])
	];
}

/**
 * The pages that answer over plain http instead of redirecting to https, each filed on itself.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function internalHttpFindings(context: AuditContext): AuditFinding[] {
	const probes = context.site.hostProbes ?? null;
	if (probes === null) return [];
	const found: AuditFinding[] = [];
	for (const probe of probes.pages) {
		if (!answersPage(probe)) continue;
		const page = context.byKey.get(probe.pageKey);
		if (page === undefined || htmlSnapshot(page) === null) continue;
		found.push(
			finding(probe.pageKey, "internal_http_page", { url: probe.url, status: probe.status })
		);
	}
	return found;
}
