import { normalizePageUrl } from "../urls";

import { bareHostOfKey } from "../scope";
import { robotsDisallowed } from "./lookups";
import {
	AUDIT_EXAMPLES,
	brokenStatus,
	canonicalKey,
	checkoutPage,
	crawlBlocked,
	finding,
	htmlSnapshot,
	indexableSnapshot,
	isHome,
	nofollowOf,
	noindexOf
} from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";

/**
 * THE INDEXABILITY RULES: what the page tells search engines (robots directives, canonicals).
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - noindex, nofollow, a missing canonical and a canonical to another page are NOTICES: each is right
 *   on some pages (a thank-you page, a duplicate) and the site owner decides;
 * - several canonical tags count only when they name DIFFERENT pages, and the HTML and the `Link`
 *   header conflict only when both exist and disagree, after URL normalization (scheme, trailing slash,
 *   tracking parameters) and the site's known variants (www twins, redirects);
 * - a canonical's target is judged only when the crawler read that target, and a target the site
 *   refused the crawler (403, 429, bot wall) is never called broken;
 * - a relative canonical is valid (Google resolves it) and is not filed;
 * - "many pages canonicalise to the home page" needs {@link CANONICAL_TO_HOME_MIN_PAGES} pages, so
 *   the one or two true duplicates of the home page (`/index.html`, `/home`) are not filed, and account
 *   pages (sign-in, password reset, confirmation) do not count: they have nothing to rank;
 * - a store's cart, checkout or order confirmation page (`./page-state` `checkoutPage`) that search
 *   engines may index is a notice (`checkout_page_indexable`, `inSitemap` when the sitemap lists it):
 *   nobody searches for one; one kept out by noindex but listed in the sitemap is
 *   `sitemap_noindex_url` instead;
 * - a canonical to another domain (often a deliberate syndication) is one finding per page:
 *   `canonical_elsewhere` names it (the Dashboard counts the page as not indexable), and the
 *   `canonical_external` insight stands only where no single canonical is followed (`./index`).
 */

/** Pages naming the home page as canonical from which it reads as a template bug. */
export const CANONICAL_TO_HOME_MIN_PAGES = 3;

/**
 * A path segment of an account page nobody searches for: signing in or up, resetting a password,
 * confirming an address or a subscription.
 */
const ACCOUNT_UTILITY_SEGMENT =
	/^(?:log-?in|sign-?in|sign-?up|register|auth|log-?out|sign-?out|(?:reset|forgot|lost|change)[-_]?password|password(?:[-_]?(?:reset|forgot))?|confirm(?:ation|ed)?|verify|verification|unsubscribe)$/i;

/**
 * Whether a page is an account page (sign-in, password reset, confirmation): its canonical to the home
 * page is harmless, as it has nothing to rank.
 *
 * @param pageKey - The page.
 * @returns Whether it is one.
 */
function accountUtilityPage(pageKey: string): boolean {
	const slash = pageKey.indexOf("/");
	const path = slash < 0 ? "" : (pageKey.slice(slash).split(/[?#]/)[0] ?? "");
	return path
		.split("/")
		.some((segment) => ACCOUNT_UTILITY_SEGMENT.test(segment.replace(/\.[a-z0-9]+$/i, "")));
}

/**
 * What is wrong with a canonical href as written, or null when it is usable.
 *
 * @param href - The href.
 * @param base - The page's URL.
 * @returns The kind, or null.
 */
function canonicalHrefProblem(href: string, base: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "") return "empty";
	let url: URL;
	try {
		url = new URL(trimmed, base);
	} catch {
		return "malformed";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "malformed";
	if (trimmed.includes("#")) return "fragment";
	return null;
}

/**
 * The canonical tag findings that read the tags as written: an unusable href, attributes Google
 * ignores the tag for, an https page naming an http URL, a canonical on another domain.
 *
 * @param page - The page.
 * @param base - The page's URL.
 * @returns The findings.
 */
function canonicalTagFindings(page: AuditPage, base: string): AuditFinding[] {
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const tags = (page.facts?.markup?.canonicals ?? []).filter((tag) => tag.inHead);
	const invalid = tags
		.map((tag) => ({ href: tag.href, kind: canonicalHrefProblem(tag.href, base) }))
		.find((entry) => entry.kind !== null);
	if (invalid !== undefined) {
		found.push(finding(key, "canonical_invalid", { kind: invalid.kind ?? "", href: invalid.href }));
	}
	const attributes = [...new Set(tags.flatMap((tag) => tag.attributes))];
	if (attributes.length > 0) {
		found.push(finding(key, "canonical_invalid_attributes", { attributes }));
	}
	const absolute = [
		...(page.facts?.canonicals ?? []),
		...(page.facts?.headers.linkCanonical == null ? [] : [page.facts.headers.linkCanonical])
	];
	if (/^https:/i.test(base)) {
		const downgraded = absolute.find((url) => /^http:/i.test(url));
		if (downgraded !== undefined) {
			found.push(finding(key, "canonical_protocol_mismatch", { target: downgraded }));
		}
	}
	const own = bareHostOfKey(key);
	const external = absolute
		.map((url) => normalizePageUrl(url))
		.find((target): target is string => target !== null && bareHostOfKey(target) !== own);
	if (external !== undefined) found.push(finding(key, "canonical_external", { target: external }));
	return found;
}

/**
 * The whole-site canonical finding: many pages naming the home page as their canonical.
 *
 * @param context - The audit.
 * @returns The finding, filed on the home page, or nothing.
 */
export function canonicalToHomeFindings(context: AuditContext): AuditFinding[] {
	const home = context.site.homeKey;
	if (home === null) return [];
	const target = context.resolve(home);
	const pages = context.pages.filter((page) => {
		if (isHome(page, context) || htmlSnapshot(page) === null) return false;
		if (accountUtilityPage(page.pageKey)) return false;
		return canonicalKey(page, context) === target;
	});
	if (pages.length < CANONICAL_TO_HOME_MIN_PAGES) return [];
	return [
		finding(home, "canonical_to_home", {
			count: pages.length,
			pages: pages.map((page) => page.pageKey).slice(0, AUDIT_EXAMPLES)
		})
	];
}

/**
 * The key the page's first canonical tag spells, before the site's variants are applied.
 *
 * @param page - The page.
 * @returns The key, or null.
 */
function rawCanonical(page: AuditPage): string | null {
	const raw = page.facts?.canonicals[0] ?? page.snapshot?.canonical ?? "";
	return raw === "" ? null : normalizePageUrl(raw);
}

/**
 * The indexability findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function indexingFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null || snapshot.mode === "rendered") return [];
	const key = page.pageKey;
	const self = context.resolve(key);
	const found: AuditFinding[] = [];
	const noindex = noindexOf(snapshot);
	if (noindex) found.push(finding(key, "noindex"));
	if (checkoutPage(key) && indexableSnapshot(page, context) !== null)
		found.push(finding(key, "checkout_page_indexable", { inSitemap: page.inSitemap }));
	if (nofollowOf(snapshot)) found.push(finding(key, "nofollow"));
	found.push(...canonicalTagFindings(page, snapshot.finalUrl ?? `https://${key}`));

	const facts = page.facts ?? null;
	const htmlTargets = [
		...new Set(
			(facts?.canonicals ?? (snapshot.canonical ? [snapshot.canonical] : []))
				.map((url) => normalizePageUrl(url))
				.filter((target): target is string => target !== null)
				.map(context.resolve)
		)
	];
	const header = facts?.headers.linkCanonical ?? null;
	const headerKey = header === null ? null : normalizePageUrl(header);
	const headerTarget = headerKey === null ? null : context.resolve(headerKey);
	if (htmlTargets.length === 0 && headerTarget === null) {
		if (!noindex) found.push(finding(key, "canonical_missing"));
		return found;
	}
	if (htmlTargets.length > 1) {
		found.push(
			finding(key, "canonical_multiple", {
				count: htmlTargets.length,
				targets: htmlTargets.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	const html = htmlTargets[0] ?? null;
	if (html !== null && headerTarget !== null && html !== headerTarget) {
		found.push(finding(key, "canonical_conflict", { html, header: headerTarget }));
	}
	const target = canonicalKey(page, context) ?? headerTarget;
	if (target === null || target === self || htmlTargets.length > 1) return found;
	found.push(finding(key, "canonical_elsewhere", { target }));
	if (noindex) found.push(finding(key, "canonical_noindex_conflict", { target }));
	if (robotsDisallowed(target, context)) {
		found.push(finding(key, "canonical_target_disallowed", { target }));
	}
	const named = htmlTargets.length === 1 ? rawCanonical(page) : headerKey;
	if (named !== null && named !== target) {
		const hop = context.byKey.get(named)?.status ?? null;
		found.push(
			finding(key, "canonical_target_redirect", {
				target: named,
				...(hop !== null && hop >= 300 && hop < 400 ? { status: hop } : {})
			})
		);
		return found;
	}
	const landing = context.byKey.get(target);
	if (landing === undefined || crawlBlocked(landing) || landing.lastError !== null) return found;
	const status = landing.status ?? landing.snapshot?.status ?? null;
	if (brokenStatus(status)) {
		found.push(finding(key, "canonical_target_error", { status: status ?? 0, target }));
	} else if (status !== null && status >= 300 && status < 400) {
		found.push(finding(key, "canonical_target_redirect", { status, target }));
	} else {
		const targetSnapshot = htmlSnapshot(landing);
		if (
			targetSnapshot !== null &&
			targetSnapshot.mode !== "rendered" &&
			noindexOf(targetSnapshot)
		) {
			found.push(finding(key, "canonical_target_noindex", { target }));
		}
		const onward = targetSnapshot === null ? null : canonicalKey(landing, context);
		if (onward !== null && onward !== target) {
			found.push(finding(key, "canonical_chain", { target, next: onward, loop: onward === self }));
		}
	}
	return found;
}
