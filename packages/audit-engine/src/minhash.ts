import { normalizeMainText, wordsOf } from "./main-text";

/**
 * A FINGERPRINT OF A PAGE'S MAIN TEXT for finding near-duplicate pages without keeping the text: the
 * MinHash signature of its word three-grams. Two signatures agree in about the share of positions that
 * the two texts' three-grams overlap (their Jaccard similarity), so pages are compared by their
 * signatures alone, and the signatures' bands bucket a site of any size so only likely pairs are ever
 * compared (locality-sensitive hashing, no comparison of every pair). Numbers and dates are folded
 * before hashing, as the change history folds them. Pure and the same on every runtime.
 */

/** The values in a signature. */
export const MINHASH_SIZE = 128;

/** The bands a signature is cut into for bucketing; each band holds `MINHASH_SIZE / MINHASH_BANDS` values. */
export const MINHASH_BANDS = 16;

/** The words a text needs before it gets a signature. */
export const MINHASH_MIN_WORDS = 50;

/** The words of a text that are fingerprinted, so a very long page costs a bounded time. */
const MAX_WORDS = 50_000;

/** The values in one band. */
const ROWS = MINHASH_SIZE / MINHASH_BANDS;

/**
 * The 32-bit finalizer of MurmurHash3: spreads every input bit over the output.
 *
 * @param value - A 32-bit value.
 * @returns The mixed value, unsigned.
 */
function mix(value: number): number {
	let h = value >>> 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/** One seed per signature position, fixed so every runtime and every read agrees. */
const SEEDS: Uint32Array = (() => {
	const seeds = new Uint32Array(MINHASH_SIZE);
	let state = 0x9e3779b9;
	for (let index = 0; index < MINHASH_SIZE; index += 1) {
		state = (state + 0x9e3779b9) >>> 0;
		seeds[index] = mix(state);
	}
	return seeds;
})();

/**
 * The FNV-1a hash of a string's UTF-16 code units.
 *
 * @param text - The text.
 * @returns The 32-bit hash, unsigned.
 */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * The MinHash signature of a main text.
 *
 * @param text - The main text.
 * @returns The signature, or null when the text holds fewer than {@link MINHASH_MIN_WORDS} words.
 */
export function minhashSignature(text: string): Uint32Array | null {
	const words = wordsOf(normalizeMainText(text)).slice(0, MAX_WORDS);
	if (words.length < MINHASH_MIN_WORDS) return null;
	const grams = new Set<number>();
	for (let index = 0; index + 3 <= words.length; index += 1) {
		grams.add(fnv1a(`${words[index]} ${words[index + 1]} ${words[index + 2]}`));
	}
	const signature = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
	for (const gram of grams) {
		for (let position = 0; position < MINHASH_SIZE; position += 1) {
			const value = mix(gram ^ (SEEDS[position] ?? 0));
			if (value < (signature[position] ?? 0)) signature[position] = value;
		}
	}
	return signature;
}

/**
 * A signature as stored: base64 of its values, little-endian.
 *
 * @param signature - The signature.
 * @returns The stored form.
 */
export function encodeSignature(signature: Uint32Array): string {
	const bytes = new Uint8Array(signature.length * 4);
	const view = new DataView(bytes.buffer);
	signature.forEach((value, index) => view.setUint32(index * 4, value, true));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * A stored signature read back.
 *
 * @param stored - The stored form.
 * @returns The signature, or null when it is not one of {@link MINHASH_SIZE} values.
 */
export function decodeSignature(stored: string): Uint32Array | null {
	let binary: string;
	try {
		binary = atob(stored);
	} catch {
		return null;
	}
	if (binary.length !== MINHASH_SIZE * 4) return null;
	const view = new DataView(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1)
		view.setUint8(index, binary.charCodeAt(index));
	const signature = new Uint32Array(MINHASH_SIZE);
	for (let index = 0; index < MINHASH_SIZE; index += 1)
		signature[index] = view.getUint32(index * 4, true);
	return signature;
}

/**
 * How alike two texts are, estimated from their signatures: the share of positions that agree.
 *
 * @param left - One signature.
 * @param right - The other.
 * @returns 0 to 1.
 */
export function signatureSimilarity(left: Uint32Array, right: Uint32Array): number {
	let same = 0;
	for (let index = 0; index < MINHASH_SIZE; index += 1) if (left[index] === right[index]) same += 1;
	return same / MINHASH_SIZE;
}

/**
 * The bucket of each band of a signature: two texts land in the same bucket of a band when that whole
 * band agrees, which a pair at 90% similarity does in at least one of the bands nearly always. Shorter
 * bands (fewer values each, more bands) also bucket pairs that agree less, at the cost of more pairs.
 *
 * @param signature - The signature.
 * @param rows - The values in one band; {@link MINHASH_SIZE} divided by the bands by default.
 * @returns One bucket key per band.
 */
export function signatureBands(signature: Uint32Array, rows: number = ROWS): number[] {
	const keys: number[] = [];
	const bands = Math.floor(MINHASH_SIZE / rows);
	for (let band = 0; band < bands; band += 1) {
		let hash = mix(band + 1);
		for (let row = 0; row < rows; row += 1) {
			hash = mix(hash ^ (signature[band * rows + row] ?? 0));
		}
		keys.push(hash);
	}
	return keys;
}
