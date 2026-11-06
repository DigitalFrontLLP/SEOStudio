/**
 * LINKED DOCUMENTS: which links of a page point at a document (a PDF, an office file, an e-book) rather
 * than a page, and a PDF's title read from the bytes at its two ends (its document information
 * dictionary, or its XMP metadata). Search engines index these files and show their title as the
 * result's title, so a document without one shows as its file name. Pure: no network.
 */

/** The file extensions of a linked document. */
const DOCUMENT_PATH = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub)$/iu;

/** The most characters of a title kept. */
const TITLE_CHARS = 300;

/** The characters after `<dc:title>` the XMP title is looked for in. */
const XMP_WINDOW = 4_000;

/**
 * Whether a URL names a document by its path.
 *
 * @param url - The absolute URL.
 * @returns Whether it is a document.
 */
export function isDocumentUrl(url: string): boolean {
	try {
		return DOCUMENT_PATH.test(new URL(url).pathname);
	} catch {
		return false;
	}
}

/**
 * Whether a document is a PDF, by its content type or, when the server names none that says, its path.
 *
 * @param url - The URL checked.
 * @param contentType - The answer's `Content-Type`, or null.
 * @returns Whether it is a PDF.
 */
export function isPdf(url: string, contentType: string | null): boolean {
	const type = (contentType ?? "").toLowerCase();
	if (type.includes("application/pdf")) return true;
	if (type !== "" && !type.includes("octet-stream")) return false;
	try {
		return /\.pdf$/iu.test(new URL(url).pathname);
	} catch {
		return false;
	}
}

/**
 * Bytes as Latin-1 text, one character per byte, so a byte offset is a character offset.
 *
 * @param bytes - The bytes.
 * @returns The text.
 */
function latin1(bytes: Uint8Array): string {
	let text = "";
	for (let start = 0; start < bytes.length; start += 8_192) {
		text += String.fromCharCode(...bytes.subarray(start, start + 8_192));
	}
	return text;
}

/**
 * A PDF text string's characters decoded: UTF-16BE behind its byte order mark, else PDFDocEncoding
 * (read as Latin-1, which it matches for the printable range).
 *
 * @param raw - The string's bytes, one per character.
 * @returns The text.
 */
function pdfText(raw: string): string {
	if (raw.startsWith("þÿ")) {
		let text = "";
		for (let index = 2; index + 1 < raw.length; index += 2) {
			text += String.fromCharCode((raw.charCodeAt(index) << 8) | raw.charCodeAt(index + 1));
		}
		return text;
	}
	return raw;
}

/**
 * The content of a PDF literal string starting just after its opening parenthesis: balanced
 * parentheses kept, escapes read.
 *
 * @param text - The file's text.
 * @param start - The index after `(`.
 * @returns The string's characters, or null when it does not close in the bytes read.
 */
function literalString(text: string, start: number): string | null {
	let depth = 1;
	let out = "";
	for (let index = start; index < text.length && out.length <= TITLE_CHARS * 4; index += 1) {
		const char = text[index] ?? "";
		if (char === "\\") {
			const next = text[index + 1] ?? "";
			index += 1;
			if (/[0-7]/u.test(next)) {
				const octal = /^[0-7]{1,3}/u.exec(text.slice(index, index + 3))?.[0] ?? next;
				out += String.fromCharCode(Number.parseInt(octal, 8));
				index += octal.length - 1;
				continue;
			}
			const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
			out += escapes[next] ?? (next === "\r" || next === "\n" ? "" : next);
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return out;
		}
		out += char;
	}
	return null;
}

/**
 * A title cut and folded, or null when nothing readable is left.
 *
 * @param value - The title.
 * @returns The title kept.
 */
function keptTitle(value: string): string | null {
	const folded = value
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return folded === "" ? null : folded.slice(0, TITLE_CHARS);
}

/**
 * The `/Title` of a PDF dictionary's text (a literal or a hex string), or null when it holds none.
 *
 * @param text - The dictionary's text.
 * @returns The title, or null.
 */
function dictionaryTitle(text: string): string | null {
	for (const match of text.matchAll(/\/Title\s*(\(|<(?!<))/gu)) {
		const at = (match.index ?? 0) + match[0].length;
		if (match[1] === "(") {
			const raw = literalString(text, at);
			const title = raw === null ? null : keptTitle(pdfText(raw));
			if (title !== null) return title;
			continue;
		}
		const close = text.indexOf(">", at);
		if (close === -1) continue;
		const hex = text.slice(at, close).replace(/\s+/gu, "");
		if (!/^[0-9a-f]*$/iu.test(hex)) continue;
		let raw = "";
		for (let index = 0; index + 1 < hex.length; index += 2) {
			raw += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
		}
		const title = keptTitle(pdfText(raw));
		if (title !== null) return title;
	}
	return null;
}

/**
 * The XMP metadata's `dc:title`, or null when the text holds none.
 *
 * @param text - The file's text.
 * @returns The title, or null.
 */
function xmpTitle(text: string): string | null {
	const open = text.indexOf("<dc:title>");
	if (open === -1) return null;
	const window = text.slice(open, open + XMP_WINDOW);
	const item = window.indexOf("<rdf:li");
	const start = item === -1 ? -1 : window.indexOf(">", item);
	const end = start === -1 ? -1 : window.indexOf("</rdf:li>", start);
	if (end === -1) return null;
	const raw = window.slice(start + 1, end);
	let decoded = raw;
	try {
		decoded = new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
	} catch {
		decoded = raw;
	}
	return keptTitle(
		decoded
			.replace(/&lt;/gu, "<")
			.replace(/&gt;/gu, ">")
			.replace(/&quot;/gu, '"')
			.replace(/&apos;/gu, "'")
			.replace(/&amp;/gu, "&")
	);
}

/** A trailer's `/Encrypt` entry (a reference or a dictionary), never `/EncryptMetadata`. */
const ENCRYPTED = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/u;

/**
 * A PDF's title from the bytes read at its start and its end: the `/Title` of the document information
 * dictionary the trailer names (never a bookmark's), else the XMP metadata's `dc:title`. An encrypted
 * PDF's strings are encrypted too (a file protected against editing opens without a password but still
 * encrypts them), so its information dictionary is never read as text: only a plain XMP title counts.
 *
 * @param chunks - The bytes read (the file's first and last bytes).
 * @returns The title; `''` when the bytes show the file holds none; null when it cannot be told (not a
 *   PDF, an encrypted PDF without a plain XMP title, or its information dictionary sits where the bytes
 *   read do not reach, such as a compressed object stream).
 */
export function pdfTitleOf(chunks: readonly Uint8Array[]): string | null {
	const text = chunks.map(latin1).join("\n");
	if (!text.startsWith("%PDF-")) return null;
	if (ENCRYPTED.test(text)) return xmpTitle(text);
	const info = [...text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/gu)].at(-1);
	let infoRead = info === undefined;
	if (info !== undefined) {
		const header = new RegExp(
			`(?:^|[^0-9])${info[1] ?? ""}\\s+${info[2] ?? ""}\\s+obj\\b`,
			"u"
		).exec(text);
		if (header !== null) {
			const start = header.index + header[0].length;
			const end = text.indexOf("endobj", start);
			const body = text.slice(start, end === -1 ? undefined : end);
			const title = dictionaryTitle(body);
			if (title !== null) return title;
			infoRead = end !== -1;
		}
	}
	const xmp = xmpTitle(text);
	if (xmp !== null) return xmp;
	return infoRead ? "" : null;
}
