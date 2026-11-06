import type { SeoUrlRewrite } from "./facts";
import { RE2JS } from "re2js";

import { SEO_CUSTOM_CHECK_LIMITS } from "./reading-limits";

/**
 * THE MEMBERS' REGULAR EXPRESSION URL REWRITES: each URL the crawl finds is rewritten by them, in
 * order, before the project's other URL rules and before it is keyed (a session id dropped, an old
 * path mapped to the new one).
 *
 * SAFE BY CONSTRUCTION: every expression is matched by RE2 (`re2js`), whose time grows linearly with
 * the URL and the expression's compiled size (bounded when saved), never exponentially, so no rewrite
 * can stall a crawl; a URL is at most a few thousand
 * characters and a rewrite that would grow it past {@link SEO_URL_REWRITE_LIMITS}.urlChars is not
 * applied. Pure.
 */

/** How many rewrites a project may save, and how long each part may be. */
export const SEO_URL_REWRITE_LIMITS = {
	/** Rewrites per project. */
	rewrites: 10,
	/** Characters of an expression, and of a replacement. */
	patternChars: 300,
	replaceChars: 300,
	/** The longest URL a rewrite may produce. */
	urlChars: 2_048
} as const;

/** One rewrite, compiled. */
export interface CompiledUrlRewrite {
	regex: RE2JS;
	replace: string;
}

/**
 * Compiles one rewrite, or null when its expression cannot be compiled, is too long, or compiles to a
 * program too large to run on every URL (the custom patterns' bound).
 *
 * @param rewrite - The rewrite.
 * @returns The compiled rewrite, or null.
 */
export function compileUrlRewrite(rewrite: SeoUrlRewrite): CompiledUrlRewrite | null {
	if (rewrite.pattern === "" || rewrite.pattern.length > SEO_URL_REWRITE_LIMITS.patternChars)
		return null;
	if (rewrite.replace.length > SEO_URL_REWRITE_LIMITS.replaceChars) return null;
	try {
		const regex = RE2JS.compile(rewrite.pattern);
		if (regex.programSize() > SEO_CUSTOM_CHECK_LIMITS.regexProgram) return null;
		return { regex, replace: rewrite.replace };
	} catch {
		return null;
	}
}

/**
 * Whether a rewrite's expression compiles.
 *
 * @param pattern - The expression.
 * @returns Whether it can be saved.
 */
export function urlRewriteValid(pattern: string): boolean {
	return compileUrlRewrite({ pattern, replace: "" }) !== null;
}

/**
 * Whether a rewrite kept the URL where it was: both read by the WHATWG parser the fetch uses, the same
 * scheme, host and port, and no user name or password. A rewrite may change a path or a query, never
 * where the crawl goes.
 *
 * @param before - The URL before the rewrite.
 * @param after - The rewritten URL.
 * @returns Whether it stays.
 */
function sameOrigin(before: string, after: string): boolean {
	try {
		const from = new URL(before);
		const to = new URL(after);
		return (
			(to.protocol === "https:" || to.protocol === "http:") &&
			to.protocol === from.protocol &&
			to.host === from.host &&
			to.username === "" &&
			to.password === ""
		);
	} catch {
		return false;
	}
}

/**
 * A URL rewritten by every compiled rewrite in turn. A rewrite whose replacement names a group the
 * expression lacks, that would make the URL too long, or that would move it to another scheme, host or
 * port (or add credentials) is skipped.
 *
 * @param url - The absolute URL.
 * @param rewrites - The compiled rewrites.
 * @returns The rewritten URL.
 */
export function applyUrlRewrites(url: string, rewrites: readonly CompiledUrlRewrite[]): string {
	let current = url;
	for (const rewrite of rewrites) {
		let next: string;
		try {
			next = rewrite.regex.matcher(current).replaceAll(rewrite.replace);
		} catch {
			continue;
		}
		if (next === current || next.length > SEO_URL_REWRITE_LIMITS.urlChars) continue;
		if (!sameOrigin(current, next)) continue;
		current = next;
	}
	return current;
}
