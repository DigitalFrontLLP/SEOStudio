import { createHash } from "node:crypto";

import { bytesToBase64 } from "./base64";
import { bytesStream, gunzipCapped, readStreamCapped } from "./bytes";

/**
 * A page's MAIN TEXT as the change history compares it.
 *
 * Numbers and dates are normalized before hashing, so a visitor counter, a "3 days ago" or a copyright
 * year rolling over is not a content change. The share of words changed is measured on word
 * three-grams, which is linear in the page's length and moves with insertions and deletions the way a
 * reader would count them.
 */

/** Month names, English, as dates are spelled in running text. */
const MONTHS =
	"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** Dates in the common written forms. */
const DATE_PATTERNS: RegExp[] = [
	/\b\d{4}-\d{1,2}-\d{1,2}(?:[t ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi,
	/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
	new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{2,4}\\b`, "gi"),
	new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}\\b`, "gi"),
	/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi
];

/** A run of digits, with thousands separators and decimals. */
const NUMBER_PATTERN = /\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?/g;

/**
 * A word, as the count and the comparison read it: a run of letters or digits, or ONE Chinese or
 * Japanese character (those scripts write no spaces between words, so a whole sentence would read as
 * one word; counting each character, as word processors do, keeps their pages comparable with others).
 */
const WORD_PATTERN =
	/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{N}#])+(?:['’]\p{L}+)?/gu;

/**
 * Counts the words of a text.
 *
 * @param text - The text.
 * @returns How many words it holds.
 */
export function countWords(text: string): number {
	return text.match(WORD_PATTERN)?.length ?? 0;
}

/**
 * The words of a text, as the count and the comparison read them.
 *
 * @param text - The text.
 * @returns Its words, in order.
 */
export function wordsOf(text: string): string[] {
	return text.match(WORD_PATTERN) ?? [];
}

/**
 * The text as it is compared: lowercased, dates and numbers folded to placeholders, whitespace
 * collapsed.
 *
 * @param text - The main text.
 * @returns The comparable form.
 */
export function normalizeMainText(text: string): string {
	let normalized = text.toLowerCase().normalize("NFC");
	for (const pattern of DATE_PATTERNS) normalized = normalized.replace(pattern, " #date ");
	return normalized.replace(NUMBER_PATTERN, "#").replace(/\s+/g, " ").trim();
}

/**
 * The sha256 of a value.
 *
 * @param value - The text.
 * @returns The hex digest.
 */
export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * The hash a snapshot stores for its main text.
 *
 * @param text - The main text.
 * @returns The hex digest of its normalized form.
 */
export function mainTextHash(text: string): string {
	return sha256(normalizeMainText(text));
}

/**
 * The word three-grams of a text, counted.
 *
 * @param text - The text, normalized.
 * @returns Each three-gram with how often it occurs.
 */
function shingles(text: string): Map<string, number> {
	const words = text.match(WORD_PATTERN) ?? [];
	const counts = new Map<string, number>();
	if (words.length < 3) {
		if (words.length > 0) counts.set(words.join(" "), 1);
		return counts;
	}
	for (let index = 0; index + 3 <= words.length; index += 1) {
		const gram = `${words[index]} ${words[index + 1]} ${words[index + 2]}`;
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	return counts;
}

/**
 * The share of a page's words that changed between two readings, 0 to 1.
 *
 * @param before - The earlier main text.
 * @param after - The later main text.
 * @returns 1 minus the overlap of their word three-grams over the larger of the two.
 */
export function textChangedShare(before: string, after: string): number {
	const left = shingles(normalizeMainText(before));
	const right = shingles(normalizeMainText(after));
	const size = (counts: Map<string, number>): number =>
		[...counts.values()].reduce((sum, count) => sum + count, 0);
	const larger = Math.max(size(left), size(right));
	if (larger === 0) return 0;
	let shared = 0;
	for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
	return Math.round((1 - shared / larger) * 1000) / 1000;
}

/**
 * Decodes base64 to bytes without `Buffer`.
 *
 * @param text - The base64 text.
 * @returns The bytes.
 */
function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** The most a stored main text unpacks to: far above any page the crawler keeps. */
const MAX_STORED_TEXT_BYTES = 32 * 1024 * 1024;

/**
 * Compresses a main text for storage.
 *
 * @param text - The text.
 * @returns gzip, base64-encoded.
 */
export async function compressText(text: string): Promise<string> {
	const packed = bytesStream(new TextEncoder().encode(text)).pipeThrough(
		new CompressionStream("gzip")
	);
	return bytesToBase64((await readStreamCapped(packed, MAX_STORED_TEXT_BYTES)).body);
}

/**
 * Reads a stored main text back.
 *
 * @param stored - gzip, base64-encoded.
 * @returns The text.
 */
export async function decompressText(stored: string): Promise<string> {
	return new TextDecoder().decode(
		(await gunzipCapped(fromBase64(stored), MAX_STORED_TEXT_BYTES)).body
	);
}
