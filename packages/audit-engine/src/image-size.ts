/**
 * AN IMAGE'S PIXEL SIZE FROM ITS FIRST BYTES: PNG, GIF, JPEG, WebP, AVIF and BMP state their width and
 * height in a header near the start of the file, so a ranged read of the first few kilobytes tells it
 * without downloading the image. Pure.
 */

/** An image's pixel size. */
export interface SeoImageSize {
	width: number;
	height: number;
}

/**
 * A big-endian 16-bit number.
 *
 * @param bytes - The bytes.
 * @param at - The offset.
 * @returns The number.
 */
function u16be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

/**
 * A little-endian 16-bit number.
 *
 * @param bytes - The bytes.
 * @param at - The offset.
 * @returns The number.
 */
function u16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/**
 * A big-endian 32-bit number.
 *
 * @param bytes - The bytes.
 * @param at - The offset.
 * @returns The number.
 */
function u32be(bytes: Uint8Array, at: number): number {
	return u16be(bytes, at) * 0x10000 + u16be(bytes, at + 2);
}

/**
 * A little-endian 24-bit number.
 *
 * @param bytes - The bytes.
 * @param at - The offset.
 * @returns The number.
 */
function u24le(bytes: Uint8Array, at: number): number {
	return u16le(bytes, at) + (bytes[at + 2] ?? 0) * 0x10000;
}

/**
 * Whether the bytes at an offset spell an ASCII tag.
 *
 * @param bytes - The bytes.
 * @param at - The offset.
 * @param tag - The tag.
 * @returns Whether they do.
 */
function tagAt(bytes: Uint8Array, at: number, tag: string): boolean {
	for (let index = 0; index < tag.length; index += 1) {
		if (bytes[at + index] !== tag.charCodeAt(index)) return false;
	}
	return true;
}

/**
 * A size, when both sides are real.
 *
 * @param width - The width.
 * @param height - The height.
 * @returns The size, or null.
 */
function sized(width: number, height: number): SeoImageSize | null {
	return width > 0 && height > 0 && width < 1_000_000 && height < 1_000_000
		? { width, height }
		: null;
}

/**
 * A JPEG's size, from its first start-of-frame segment.
 *
 * @param bytes - The file's first bytes.
 * @returns The size, or null when the frame header is not among them.
 */
function jpegSize(bytes: Uint8Array): SeoImageSize | null {
	let at = 2;
	while (at + 9 < bytes.length) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1] ?? 0;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			at += 2;
			continue;
		}
		const frame =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (frame) return sized(u16be(bytes, at + 7), u16be(bytes, at + 5));
		at += 2 + u16be(bytes, at + 2);
	}
	return null;
}

/**
 * An AVIF's (or HEIF's) size, from its first `ispe` property.
 *
 * @param bytes - The file's first bytes.
 * @returns The size, or null.
 */
function avifSize(bytes: Uint8Array): SeoImageSize | null {
	for (let at = 0; at + 16 <= bytes.length; at += 1) {
		if (tagAt(bytes, at, "ispe")) return sized(u32be(bytes, at + 8), u32be(bytes, at + 12));
	}
	return null;
}

/**
 * The pixel size an image file states in its header.
 *
 * @param bytes - The file's first bytes (a few kilobytes are enough for most files).
 * @returns The size, or null when the format is not known or the header was not among the bytes.
 */
export function imageSizeOf(bytes: Uint8Array): SeoImageSize | null {
	if (bytes.length < 10) return null;
	if (bytes[0] === 0x89 && tagAt(bytes, 1, "PNG") && tagAt(bytes, 12, "IHDR")) {
		return sized(u32be(bytes, 16), u32be(bytes, 20));
	}
	if (tagAt(bytes, 0, "GIF8")) return sized(u16le(bytes, 6), u16le(bytes, 8));
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
	if (tagAt(bytes, 0, "RIFF") && tagAt(bytes, 8, "WEBP")) {
		if (tagAt(bytes, 12, "VP8 ")) {
			return sized(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
		}
		if (tagAt(bytes, 12, "VP8L")) {
			const b0 = bytes[21] ?? 0;
			const b1 = bytes[22] ?? 0;
			const b2 = bytes[23] ?? 0;
			const b3 = bytes[24] ?? 0;
			return sized(
				1 + (((b1 & 0x3f) << 8) | b0),
				1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6))
			);
		}
		if (tagAt(bytes, 12, "VP8X")) return sized(1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
		return null;
	}
	if (tagAt(bytes, 4, "ftyp")) return avifSize(bytes);
	if (tagAt(bytes, 0, "BM") && bytes.length >= 26) {
		const width = u16le(bytes, 18) + u16le(bytes, 20) * 0x10000;
		const raw = u16le(bytes, 22) + u16le(bytes, 24) * 0x10000;
		const height = raw > 0x7fffffff ? 0x100000000 - raw : raw;
		return sized(width, height);
	}
	return null;
}

/** The application extensions that make a GIF loop: Netscape's and the older AnimExts. */
const GIF_LOOP_EXTENSIONS = ["NETSCAPE2.0", "ANIMEXTS1.0"] as const;

/**
 * The offset after a run of GIF data sub-blocks (each a length byte, then that many bytes, ended by a
 * zero length), or null when the run goes past the bytes read.
 *
 * @param bytes - The file's first bytes.
 * @param at - Where the run starts.
 * @returns The offset after it, or null.
 */
function afterGifSubBlocks(bytes: Uint8Array, at: number): number | null {
	let offset = at;
	while (offset < bytes.length) {
		const size = bytes[offset] ?? 0;
		offset += 1;
		if (size === 0) return offset;
		offset += size;
	}
	return null;
}

/**
 * Whether a GIF is animated: it asks to loop, or a second frame starts within the bytes read. A frame
 * larger than the bytes read hides the next one, so a GIF that neither loops nor shows a second frame in
 * them reads as still.
 *
 * @param bytes - The file's first bytes.
 * @returns Whether it is an animated GIF (false for any other file).
 */
export function gifAnimated(bytes: Uint8Array): boolean {
	if (!tagAt(bytes, 0, "GIF8") || bytes.length < 13) return false;
	const flags = bytes[10] ?? 0;
	let offset = 13 + ((flags & 0x80) === 0 ? 0 : 3 * 2 ** ((flags & 0x07) + 1));
	let frames = 0;
	while (offset < bytes.length) {
		const block = bytes[offset];
		if (block === 0x3b) return false;
		if (block === 0x21) {
			const label = bytes[offset + 1];
			if (label === 0xff && GIF_LOOP_EXTENSIONS.some((tag) => tagAt(bytes, offset + 3, tag)))
				return true;
			const next = afterGifSubBlocks(bytes, offset + 2);
			if (next === null) return false;
			offset = next;
			continue;
		}
		if (block !== 0x2c) return false;
		frames += 1;
		if (frames > 1) return true;
		const local = bytes[offset + 9] ?? 0;
		offset += 10 + ((local & 0x80) === 0 ? 0 : 3 * 2 ** ((local & 0x07) + 1)) + 1;
		const next = afterGifSubBlocks(bytes, offset);
		if (next === null) return false;
		offset = next;
	}
	return false;
}
