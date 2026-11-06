/** The base64 alphabet, as the ASCII codes the encoded text is written with. */
const CODES = new TextEncoder().encode(
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
);

/** The padding character's code. */
const PAD = 61;

/** Reads the encoded text: plain ASCII, which UTF-8 reads byte for byte. */
const ASCII = new TextDecoder();

/**
 * The base64 code of one six-bit group.
 *
 * @param group - The group (0 to 63).
 * @returns Its ASCII code.
 */
function code(group: number): number {
	return CODES[group & 63] ?? PAD;
}

/**
 * Encodes bytes as standard, padded base64 without `Buffer`, in one pass over a preallocated output:
 * a page's scripts and styles are handed to the rendering browser this way, megabytes per page, so the
 * encoding must cost far less than the page itself.
 *
 * @param bytes - The bytes.
 * @returns The base64 text.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	const length = bytes.length;
	const out = new Uint8Array(Math.ceil(length / 3) * 4);
	const whole = length - (length % 3);
	let at = 0;
	for (let index = 0; index < whole; index += 3) {
		const triple =
			((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
		out[at] = code(triple >>> 18);
		out[at + 1] = code(triple >>> 12);
		out[at + 2] = code(triple >>> 6);
		out[at + 3] = code(triple);
		at += 4;
	}
	if (length % 3 === 1) {
		const first = bytes[whole] ?? 0;
		out[at] = code(first >>> 2);
		out[at + 1] = code(first << 4);
		out[at + 2] = PAD;
		out[at + 3] = PAD;
	} else if (length % 3 === 2) {
		const pair = ((bytes[whole] ?? 0) << 8) | (bytes[whole + 1] ?? 0);
		out[at] = code(pair >>> 10);
		out[at + 1] = code(pair >>> 4);
		out[at + 2] = code(pair << 2);
		out[at + 3] = PAD;
	}
	return ASCII.decode(out);
}

/**
 * Decodes standard base64 (as DevTools sends a request body's bytes) without `Buffer`.
 *
 * @param text - The base64 text.
 * @returns The bytes, or null when the text is not base64.
 */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
