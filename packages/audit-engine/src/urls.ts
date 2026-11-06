/**
 * ONE KEY PER PAGE, whichever source names it. Search Console reports full URLs (any subdomain and
 * scheme of a domain property, sometimes with a fragment or tracking parameters), Analytics reports a
 * host and a path, and the crawler sees URLs as links spell them. Every join between them goes
 * through {@link normalizePageUrl}, so the same page always meets itself.
 *
 * The key is `host + path + query`: the host lowercased with `www.` and default ports kept as they
 * are told apart by redirects (an alias table maps one to the other, never this function); no scheme,
 * no fragment, no tracking parameters; the remaining parameters sorted; percent-encoding decoded to
 * one Unicode form and re-encoded the same way; a trailing slash dropped except on the root.
 */

/** Query parameters that only track a visit and never change the page. */
const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"gbraid",
	"wbraid",
	"dclid",
	"msclkid",
	"yclid",
	"twclid",
	"ttclid",
	"li_fat_id",
	"mc_cid",
	"mc_eid",
	"_ga",
	"_gl",
	"_hsenc",
	"_hsmi",
	"__hstc",
	"__hssc",
	"__hsfp",
	"igshid",
	"srsltid"
]);

/** Whether a parameter name tracks a visit (`utm_*` and the named click ids). */
function isTracking(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/**
 * Decodes one percent-encoded path or query part to Unicode NFC and encodes it back the one way, so
 * `%C3%A9`, `é` and a decomposed `é` give the same text. A malformed escape is kept as written.
 *
 * @param part - The part.
 * @param encode - How to encode it back.
 * @returns The part in its one form.
 */
function canonicalPart(part: string, encode: (value: string) => string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(part);
	} catch {
		return part;
	}
	return encode(decoded.normalize("NFC"));
}

/**
 * Encodes a path back with its separators kept.
 *
 * @param path - The decoded path.
 * @returns The encoded path.
 */
function encodePath(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/**
 * The one key a page is stored and joined under.
 *
 * @param url - An absolute URL, or a path when `host` is given.
 * @param host - The host a bare path belongs to (Analytics reports the two apart).
 * @returns The key, or null when the input names no http(s) page.
 */
export function normalizePageUrl(url: string, host?: string | null): string | null {
	const trimmed = url.trim();
	if (trimmed === "") return null;
	let parsed: URL;
	try {
		if (/^https?:\/\//i.test(trimmed)) {
			parsed = new URL(trimmed);
		} else if (host !== undefined && host !== null && host.trim() !== "") {
			const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
			parsed = new URL(`https://${host.trim()}${path}`);
		} else {
			return null;
		}
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	if (hostname === "") return null;
	const port = parsed.port === "" ? "" : `:${parsed.port}`;
	const rawPath = canonicalPart(parsed.pathname, encodePath).replace(/\/{2,}/g, "/");
	const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : "/";
	const params = [...parsed.searchParams.entries()]
		.filter(([name]) => !isTracking(name))
		.map(([name, value]) => [name.normalize("NFC"), value.normalize("NFC")] as const)
		.sort(([leftName, leftValue], [rightName, rightValue]) =>
			leftName === rightName
				? leftValue.localeCompare(rightValue)
				: leftName.localeCompare(rightName)
		);
	const query =
		params.length === 0
			? ""
			: `?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&")}`;
	return `${hostname}${port}${path === "/" ? "/" : path}${query}`;
}

/**
 * Whether Google chose another page as canonical than the one the page declares (both named, and not
 * the same page once normalized).
 *
 * @param google - The Google-selected canonical.
 * @param declared - The user-declared canonical.
 * @returns Whether they differ.
 */
export function canonicalMismatch(google: string | null, declared: string | null): boolean {
	if (google === null || declared === null) return false;
	const left = normalizePageUrl(google) ?? google;
	const right = normalizePageUrl(declared) ?? declared;
	return left !== right;
}
