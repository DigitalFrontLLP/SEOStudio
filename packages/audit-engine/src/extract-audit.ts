/**
 * THE SITE AUDIT'S READING OF SINGLE TAGS: how an image is lazy-loaded, whether it has a size, whether
 * it is too small to be a page's main image, and which subresources a page loads over plain `http:`.
 *
 * Pure functions over one tag's attributes, called by the extractor's one pass (`./extract`). Each is
 * tuned to stay quiet on the common false positives: a JavaScript lazy-loader with a real `src` is not
 * lazy, a Next.js `fill` image is sized by its style, a link to an `http:` page is not mixed content.
 */

/** The attributes JavaScript lazy-loaders keep the real image URL in (lazysizes, vanilla-lazyload, WordPress plugins). */
const LAZY_SOURCE_ATTRIBUTES = [
	"data-src",
	"data-lazy-src",
	"data-original",
	"data-srcset",
	"data-lazy-srcset",
	"data-perfmatters-src",
	"data-perfmatters-srcset",
	"data-ewww-src",
	"data-lazyload"
] as const;

/**
 * How an image is lazy-loaded.
 *
 * - `native`: `loading="lazy"`.
 * - `javascript`: a lazy-loader keeps the real URL in a `data-*` attribute AND the `src` is empty or a
 *   `data:` placeholder, so nothing loads until a script swaps it in. An image whose `src` is already
 *   the real file loads at once whatever its `data-*` attributes say.
 *
 * @param attribs - The `<img>` attributes.
 * @returns The method, or `none`.
 */
export function imageLazyMethod(attribs: Record<string, string>): "native" | "javascript" | "none" {
	if ((attribs.loading ?? "").trim().toLowerCase() === "lazy") return "native";
	const src = (attribs.src ?? "").trim();
	const placeholder = src === "" || src.toLowerCase().startsWith("data:");
	const deferred = LAZY_SOURCE_ATTRIBUTES.some((name) => (attribs[name] ?? "").trim() !== "");
	return placeholder && deferred ? "javascript" : "none";
}

/**
 * A positive number from an attribute.
 *
 * @param value - The attribute value.
 * @returns The number, or null when it is not one.
 */
function dimension(value: string | undefined): number | null {
	if (value === undefined) return null;
	const parsed = Number.parseFloat(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Whether an image reserves its space before it loads: both `width` and `height` attributes, or a
 * style that sets both, an `aspect-ratio`, or positions it absolutely in a sized box (a Next.js `fill`
 * image).
 *
 * @param attribs - The `<img>` attributes.
 * @returns Whether it is sized.
 */
export function imageSized(attribs: Record<string, string>): boolean {
	if (dimension(attribs.width) !== null && dimension(attribs.height) !== null) return true;
	const style = (attribs.style ?? "").toLowerCase();
	if (style === "") return false;
	if (/(?:^|[;\s])aspect-ratio\s*:/.test(style)) return true;
	if (/(?:^|[;\s])position\s*:\s*absolute/.test(style)) return true;
	return /(?:^|[;\s])width\s*:/.test(style) && /(?:^|[;\s])height\s*:/.test(style);
}

/**
 * Whether an image is too small, by its own attributes, to be a page's main image (an icon, an avatar,
 * a tracking pixel), or is a vector logo.
 *
 * @param attribs - The `<img>` attributes.
 * @returns Whether it is.
 */
export function imageSmall(attribs: Record<string, string>): boolean {
	const width = dimension(attribs.width);
	const height = dimension(attribs.height);
	if ((width !== null && width < 150) || (height !== null && height < 100)) return true;
	if (displayedNarrow(attribs.sizes)) return true;
	return /\.svg(?:$|[?#])/i.test(imageSource(attribs));
}

/**
 * Whether an image's `sizes` shows it under 150 CSS pixels wide at every breakpoint (a logo drawn
 * from a large file), so its intrinsic `width` says nothing about how much of the screen it fills.
 *
 * @param sizes - The `sizes` attribute.
 * @returns Whether every size it lists is a pixel length under 150.
 */
function displayedNarrow(sizes: string | undefined): boolean {
	if (sizes === undefined || sizes.length > 500) return false;
	const widths = sizes.split(",").map((part) => {
		const last = part.trim().split(/\s+/).at(-1) ?? "";
		return last.toLowerCase().endsWith("px") ? Number(last.slice(0, -2)) : Number.NaN;
	});
	return widths.length > 0 && widths.every((width) => Number.isFinite(width) && width < 150);
}

/**
 * Whether an image is hidden by its own attributes.
 *
 * @param attribs - The `<img>` attributes.
 * @returns Whether it is.
 */
export function imageHidden(attribs: Record<string, string>): boolean {
	if ("hidden" in attribs) return true;
	if ((attribs["aria-hidden"] ?? "").toLowerCase() === "true" && imageSmall(attribs)) return true;
	return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attribs.style ?? "");
}

/**
 * The URLs of a `srcset`, read as browsers read it: each candidate is a URL up to whitespace, then
 * descriptors up to a comma, so a comma inside a URL (a `data:` image, an image service's
 * `w_400,h_300` options) is part of it, never a split. One read from start to end: a URL's trailing
 * commas are dropped from its end, never by an end-anchored pattern (`/,+$/`), which retries from every
 * comma of a run and costs its square.
 *
 * @param srcset - The attribute.
 * @param work - Counts the characters looked at, when given.
 * @returns The candidates' URLs, as written.
 */
export function srcsetUrls(srcset: string, work?: { steps: number }): string[] {
	const urls: string[] = [];
	const look = (): void => {
		if (work !== undefined) work.steps += 1;
	};
	let at = 0;
	while (at < srcset.length) {
		while (at < srcset.length && /[\s,]/.test(srcset.charAt(at))) {
			look();
			at += 1;
		}
		if (at >= srcset.length) break;
		let end = at;
		while (end < srcset.length && !/\s/.test(srcset.charAt(end))) {
			look();
			end += 1;
		}
		let url = srcset.slice(at, end);
		at = end;
		if (url.endsWith(",")) {
			let cut = url.length;
			while (cut > 0 && url.charCodeAt(cut - 1) === 44) {
				look();
				cut -= 1;
			}
			url = url.slice(0, cut);
		} else {
			let depth = 0;
			while (at < srcset.length) {
				look();
				const char = srcset.charAt(at);
				if (char === "(") depth += 1;
				else if (char === ")") depth = Math.max(0, depth - 1);
				else if (char === "," && depth === 0) break;
				at += 1;
			}
		}
		if (url !== "") urls.push(url);
	}
	return urls;
}

/**
 * The URL an image shows: its `src`, else the lazy-loader's attribute, else the first `srcset` entry.
 *
 * @param attribs - The `<img>` attributes.
 * @returns The URL as written, or empty.
 */
export function imageSource(attribs: Record<string, string>): string {
	const src = (attribs.src ?? "").trim();
	if (src !== "" && !src.toLowerCase().startsWith("data:")) return src;
	for (const name of LAZY_SOURCE_ATTRIBUTES) {
		const value = (attribs[name] ?? "").trim();
		if (value !== "") return srcsetUrls(value)[0] ?? value;
	}
	const srcset = (attribs.srcset ?? "").trim();
	return srcset === "" ? src.slice(0, 80) : (srcsetUrls(srcset)[0] ?? "");
}

/** Whether a URL is plain `http:`. */
const PLAIN_HTTP = /^\s*http:\/\//i;

/**
 * The `http:` URLs a `srcset` names.
 *
 * @param srcset - The attribute.
 * @returns The plain-http candidates.
 */
function srcsetHttp(srcset: string | undefined): string[] {
	if (srcset === undefined) return [];
	return srcsetUrls(srcset).filter((url) => PLAIN_HTTP.test(url));
}

/** `<link rel>` values that load a subresource the page runs or styles with. */
const ACTIVE_LINK_RELS = new Set(["stylesheet", "preload", "modulepreload"]);

/**
 * The subresources one tag loads over plain `http:`. ACTIVE content (scripts, frames, stylesheets,
 * objects) is blocked by browsers on an https page; PASSIVE content (images, audio, video) is upgraded
 * or dropped. A link (`<a href>`), a canonical or an alternate is navigation, never mixed content.
 *
 * @param tag - The tag name, lowercased.
 * @param attribs - Its attributes.
 * @returns The http URLs it loads, by kind.
 */
export function mixedContentOf(
	tag: string,
	attribs: Record<string, string>
): { active: string[]; passive: string[] } {
	const active: string[] = [];
	const passive: string[] = [];
	const add = (into: string[], value: string | undefined): void => {
		if (value !== undefined && PLAIN_HTTP.test(value)) into.push(value.trim());
	};
	switch (tag) {
		case "script":
		case "iframe":
		case "embed":
			add(active, attribs.src);
			break;
		case "object":
			add(active, attribs.data);
			break;
		case "link": {
			const rels = (attribs.rel ?? "").toLowerCase().split(/\s+/);
			if (!rels.some((rel) => ACTIVE_LINK_RELS.has(rel))) break;
			add((attribs.as ?? "").toLowerCase() === "image" ? passive : active, attribs.href);
			break;
		}
		case "img":
		case "source":
			add(passive, attribs.src);
			passive.push(...srcsetHttp(attribs.srcset));
			break;
		case "video":
			add(passive, attribs.src);
			add(passive, attribs.poster);
			break;
		case "audio":
		case "track":
			add(passive, attribs.src);
			break;
		default:
			break;
	}
	return { active, passive };
}
