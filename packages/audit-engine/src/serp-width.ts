import { SERP_FONT_WIDTHS } from "./serp-font-widths";

/**
 * HOW WIDE A TITLE OR A DESCRIPTION SHOWS ON GOOGLE'S RESULTS PAGE, in pixels: the results page cuts a
 * title by its width, not its letters (a title of capital Ws is cut far sooner than one of small is).
 * Measured with the results page's own font metrics (`./serp-font-widths`) at the sizes it sets them
 * in on a computer. Pure.
 */

/** The font size Google's results page sets a result's title in, in pixels. */
export const SERP_TITLE_FONT_PX = 20;

/** The font size Google's results page sets a result's description in, in pixels. */
export const SERP_DESCRIPTION_FONT_PX = 14;

/** The width of a character the table does not hold, in thousandths of an em: an average letter. */
const FALLBACK_WIDTH = 556;

/** The width of a full-width character (Chinese, Japanese, Korean, full-width forms, emoji). */
const FULL_WIDTH = 1000;

/**
 * The average width of a letter of each script the table does not hold, in thousandths of an em, as
 * joined in running text: the median over 30 to 40 real headlines per script measured in a browser at
 * the results page's font (Arial first, then the script's fallback). Arabic and Hebrew were measured
 * in Arial's own glyphs (0.34 to 0.39 em for Arabic: the Latin average, 0.556, read Arabic titles half
 * as wide again as they show); the others (2026-10-08) as the mean of the system fallback font and
 * Google's Noto font for the script, which differ by up to a quarter for some scripts (Tamil, Sinhala),
 * so every width here is an estimate ({@link serpWidthEstimated}). Nonspacing marks take no width.
 */
const SCRIPT_WIDTHS: readonly (readonly [number, number, number])[] = [
	[0x0530, 0x058f, 637],
	[0x0590, 0x05ff, 475],
	[0x0600, 0x06ff, 365],
	[0x0750, 0x077f, 365],
	[0x08a0, 0x08ff, 365],
	[0x0900, 0x097f, 502],
	[0x0980, 0x09ff, 498],
	[0x0a00, 0x0a7f, 526],
	[0x0a80, 0x0aff, 502],
	[0x0b00, 0x0b7f, 525],
	[0x0b80, 0x0bff, 703],
	[0x0c00, 0x0c7f, 669],
	[0x0c80, 0x0cff, 634],
	[0x0d00, 0x0d7f, 708],
	[0x0d80, 0x0dff, 703],
	[0x0e00, 0x0e7f, 552],
	[0x0e80, 0x0eff, 546],
	[0x0f00, 0x0fff, 444],
	[0x1000, 0x109f, 725],
	[0x10a0, 0x10ff, 635],
	[0x1200, 0x137f, 700],
	[0x1780, 0x17ff, 540],
	[0xfb50, 0xfdff, 365],
	[0xfe70, 0xfeff, 365]
];

/**
 * The width of a letter of a script the table does not hold ({@link SCRIPT_WIDTHS}), or null for
 * another code point.
 *
 * @param code - The code point.
 * @returns Its width in thousandths of an em, or null.
 */
function scriptWidth(code: number): number | null {
	for (const [from, to, width] of SCRIPT_WIDTHS) {
		if (code < from) return null;
		if (code <= to) return width;
	}
	return null;
}

/** Every covered code point's width, flattened from the vendored ranges. */
const WIDTHS: ReadonlyMap<number, number> = new Map(
	SERP_FONT_WIDTHS.flatMap(([start, widths]) =>
		widths.flatMap((width, offset) => (width < 0 ? [] : [[start + offset, width] as const]))
	)
);

/**
 * Whether a code point is set full width: CJK ideographs and syllables, kana, full-width forms and
 * pictographs.
 *
 * @param code - The code point.
 * @returns Whether it is.
 */
function fullWidth(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** A mark set over or under the letter before it (accents, Arabic and Hebrew vowel marks, Indic signs). */
const NONSPACING_MARK = /^\p{Mn}$/u;

/**
 * Whether a code point takes no width of its own: a combining mark, a zero-width joiner or space, a
 * variation selector.
 *
 * @param code - The code point.
 * @param char - The character.
 * @returns Whether it does.
 */
function zeroWidth(code: number, char: string): boolean {
	return (
		NONSPACING_MARK.test(char) ||
		(code >= 0x300 && code <= 0x36f) ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code === 0xfeff
	);
}

/**
 * The width a text shows in on Google's results page, whitespace collapsed as the page collapses it.
 *
 * @param text - The title or description.
 * @param fontPx - The font size it is set in ({@link SERP_TITLE_FONT_PX} or {@link SERP_DESCRIPTION_FONT_PX}).
 * @returns Its width in whole pixels.
 */
export function serpPixelWidth(text: string, fontPx: number): number {
	let thousandths = 0;
	for (const char of text.replace(/\s+/gu, " ").trim()) {
		const code = char.codePointAt(0) ?? 0;
		if (zeroWidth(code, char)) continue;
		thousandths +=
			WIDTHS.get(code) ?? scriptWidth(code) ?? (fullWidth(code) ? FULL_WIDTH : FALLBACK_WIDTH);
	}
	return Math.round((thousandths * fontPx) / 1000);
}

/**
 * How far a width measured with averaged letters may be off either way: an Arabic headline measured
 * at the average letter came out within 10% of the browser's width for four in five texts.
 */
export const SERP_ESTIMATE_SLACK = 0.1;

/**
 * Whether a text's width rests on averaged letters: a fifth or more of the characters it shows are
 * outside the font table (a script of {@link SCRIPT_WIDTHS}, or one read at the average Latin letter), so its width
 * is an estimate and a length check gives it {@link SERP_ESTIMATE_SLACK} either way.
 *
 * @param text - The title or description.
 * @returns Whether it does.
 */
export function serpWidthEstimated(text: string): boolean {
	let shown = 0;
	let averaged = 0;
	for (const char of text.replace(/\s+/gu, "")) {
		const code = char.codePointAt(0) ?? 0;
		if (zeroWidth(code, char)) continue;
		shown += 1;
		if (!WIDTHS.has(code) && !fullWidth(code)) averaged += 1;
	}
	return shown > 0 && averaged * 5 >= shown;
}
