/**
 * ONE BYTE COUNTER for everything the crawler reads: a response body and a gzip it unpacks both stop
 * at their cap and cancel the stream, so neither a huge page nor a small gzip bomb can cost more
 * memory than the cap.
 */

/** What a capped read returns. */
export interface CappedBytes {
	body: Uint8Array;
	/** Whether the cap cut the stream. */
	truncated: boolean;
	/** The bytes seen, up to the chunk that crossed the cap. */
	sizeBytes: number;
}

/**
 * Reads a stream up to `maxBytes`, cancelling it past the cap.
 *
 * @param stream - The stream, or null for an empty body.
 * @param maxBytes - The cap.
 * @returns The bytes kept, whether the cap cut them, and the bytes seen.
 */
export async function readStreamCapped(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number
): Promise<CappedBytes> {
	if (stream === null) return { body: new Uint8Array(0), truncated: false, sizeBytes: 0 };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = maxBytes - size;
		if (value.byteLength > room) {
			if (room > 0) chunks.push(value.subarray(0, room));
			size += value.byteLength;
			truncated = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	const body = new Uint8Array(Math.min(size, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body, truncated, sizeBytes: size };
}

/**
 * Hands a stream's bytes to a sink as they arrive, up to `maxBytes`, holding none of them: the stream
 * is cancelled past the cap, or as soon as the sink says it takes no more. A stream that fails after
 * its first bytes (a slow host past the time limit, a dropped connection) ends as cut, the bytes that
 * arrived handed on; one that fails before any throws.
 *
 * @param stream - The stream, or null for an empty body.
 * @param maxBytes - The cap.
 * @param sink - Takes each piece; answers whether it takes more.
 * @returns Whether the stream was cut (by the cap or a failure), and the bytes seen.
 */
export async function drainStreamCapped(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	sink: (bytes: Uint8Array) => Promise<boolean>
): Promise<Omit<CappedBytes, "body">> {
	if (stream === null) return { truncated: false, sizeBytes: 0 };
	const reader = stream.getReader();
	let size = 0;
	for (;;) {
		let next: ReadableStreamReadResult<Uint8Array>;
		try {
			next = await reader.read();
		} catch (error) {
			if (size === 0) throw error;
			return { truncated: true, sizeBytes: size };
		}
		const { done, value } = next;
		if (done) return { truncated: false, sizeBytes: size };
		const room = maxBytes - size;
		size += value.byteLength;
		const over = value.byteLength > room;
		const more = await sink(over ? value.subarray(0, Math.max(0, room)) : value);
		if (over || !more) {
			await reader.cancel().catch(() => undefined);
			return { truncated: over, sizeBytes: size };
		}
	}
}

/**
 * A stream over a copy of some bytes (the copy owns a plain `ArrayBuffer`, which `Blob` requires).
 *
 * @param bytes - The bytes.
 * @returns The stream.
 */
export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Blob([copy]).stream();
}

/**
 * Unpacks gzip bytes, stopping at `maxBytes` of output.
 *
 * @param bytes - The gzip bytes.
 * @param maxBytes - The most unpacked bytes kept.
 * @returns The unpacked bytes (cut at the cap) and whether the cap cut them.
 */
export async function gunzipCapped(bytes: Uint8Array, maxBytes: number): Promise<CappedBytes> {
	return readStreamCapped(
		bytesStream(bytes).pipeThrough(new DecompressionStream("gzip")),
		maxBytes
	);
}
