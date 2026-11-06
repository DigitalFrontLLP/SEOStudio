import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";
import type { Dispatcher, Response as UndiciResponse } from "undici";

import type { SeoCrawlFetcher } from "./types";

/**
 * THE CRAWLER'S ADDRESS GUARD: the transport a standalone crawl reads the web through by default, so a
 * page that links or redirects to a private address (the machine itself, the local network, a cloud's
 * metadata service) can never make the crawler fetch it.
 *
 * Every request, each redirect hop included (the crawler follows redirects itself, one request per
 * hop), is checked before it is sent: http or https only, no credentials in the URL, the host resolved
 * and refused when ANY address it resolves to is loopback, unspecified, private (RFC 1918), shared
 * (CGNAT), link-local (the metadata address included), unique-local, multicast, reserved, or an IPv6
 * address carrying such an IPv4 (mapped, NAT64, 6to4). The connection is then pinned to the very
 * addresses checked, so a host that answers DNS with a public address and then a private one cannot
 * be dialled on an address the guard never saw. A redirect is returned as it is, never followed.
 *
 * A refused request throws an error named `BlockedUrlError` whose `reason` says why (`refused`,
 * `not_found` when the host does not exist, `dns_unavailable` when DNS could not answer), which the
 * crawler files as a blocked, missing or unreachable URL.
 */

/** Why a URL failed the guard. */
export type BlockedUrlReason = "refused" | "not_found" | "dns_unavailable";

/** Thrown when a URL fails the guard. */
export class BlockedUrlError extends Error {
	readonly reason: BlockedUrlReason;

	/**
	 * @param message - What was refused.
	 * @param reason - Why.
	 */
	constructor(message: string, reason: BlockedUrlReason = "refused") {
		super(message);
		this.name = "BlockedUrlError";
		this.reason = reason;
	}
}

/** How the guarded transport is built. */
export interface GuardedFetchOptions {
	/**
	 * The host names (lower-cased; an IPv6 literal with or without its brackets) whose private or local
	 * addresses may be reached: a staging site on the local network or on this machine, named one by
	 * one. Every other host stays guarded, so a link from that site to another private address (a
	 * cloud's metadata service, the local network) is still refused. Empty by default.
	 */
	allowPrivateHosts?: ReadonlySet<string>;
}

/** The resolver error codes that say a name does not exist, as opposed to DNS failing for now. */
const NAME_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
	"ENOTFOUND",
	"ENODATA",
	"EAI_NONAME",
	"EAI_NODATA"
]);

/** Statuses the fetch spec forbids a body on. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * An IPv4 address as its four octets.
 *
 * @param address - The address.
 * @returns The octets, or null when it is not a dotted-quad IPv4 address.
 */
function parseIpv4(address: string): [number, number, number, number] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number.parseInt(part, 10);
		if (octet > 255) return null;
		octets.push(octet);
	}
	return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

/**
 * One side of an IPv6 address (around its `::`) as 16-bit groups.
 *
 * @param side - The side.
 * @param dottedTail - Whether its last part may be a dotted IPv4.
 * @returns The groups, or null when malformed.
 */
function ipv6Groups(side: string, dottedTail: boolean): number[] | null {
	if (side === "") return [];
	const parts = side.split(":");
	const groups: number[] = [];
	for (const [index, part] of parts.entries()) {
		if (dottedTail && index === parts.length - 1 && part.includes(".")) {
			const octets = parseIpv4(part);
			if (octets === null) return null;
			groups.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
			continue;
		}
		if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
		groups.push(Number.parseInt(part, 16));
	}
	return groups;
}

/**
 * An IPv6 address as its eight 16-bit groups, whatever its spelling (compressed, expanded, dotted
 * tail).
 *
 * @param address - The address, lowercased, without a zone.
 * @returns The groups, or null when it is not an IPv6 address.
 */
function parseIpv6(address: string): number[] | null {
	if (!address.includes(":")) return null;
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const compressed = halves.length === 2;
	const head = ipv6Groups(halves[0] ?? "", !compressed);
	const tail = compressed ? ipv6Groups(halves[1] ?? "", true) : [];
	if (head === null || tail === null) return null;
	const missing = 8 - head.length - tail.length;
	if (compressed ? missing < 1 : missing !== 0) return null;
	return [...head, ...Array.from<number>({ length: missing }).fill(0), ...tail];
}

/**
 * The IPv4 address two 16-bit groups carry.
 *
 * @param high - The high group.
 * @param low - The low group.
 * @returns The dotted address.
 */
function ipv4Of(high: number, low: number): string {
	return `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`;
}

/**
 * Whether an IPv4 address is refused: unspecified (`0/8`), loopback (`127/8`), private (`10/8`,
 * `172.16/12`, `192.168/16`), shared (`100.64/10`), link-local with the metadata address (`169.254/16`),
 * protocol assignments (`192.0.0/24`), benchmarking (`198.18/15`), multicast, reserved and broadcast
 * (`224/4`, `240/4`). An address that does not parse is refused.
 *
 * @param address - The address.
 * @returns Whether it is refused.
 */
function blockedIpv4(address: string): boolean {
	const octets = parseIpv4(address);
	if (octets === null) return true;
	const [a, b, c] = octets;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && (b === 168 || (b === 0 && c === 0))) return true;
	if (a === 169 && b === 254) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return a === 198 && (b === 18 || b === 19);
}

/**
 * Whether an IPv6 address is refused: the unspecified, loopback and IPv4-compatible block (an
 * IPv4-mapped or translated address follows its IPv4), NAT64 (follows its IPv4; the local-use block
 * refused), discard, Teredo, documentation, 6to4 (follows its IPv4), and everything outside global
 * unicast (unique-local, link-local, site-local, multicast). An address that does not parse is refused.
 *
 * @param address - The address.
 * @returns Whether it is refused.
 */
function blockedIpv6(address: string): boolean {
	const zone = address.indexOf("%");
	const groups = parseIpv6((zone === -1 ? address : address.slice(0, zone)).toLowerCase());
	if (groups === null) return true;
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
	if (a === 0) {
		if (b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return blockedIpv4(ipv4Of(g, h));
		if (b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return blockedIpv4(ipv4Of(g, h));
		return true;
	}
	if (a === 0x64 && b === 0xff9b) {
		return c === 0 && d === 0 && e === 0 && f === 0 ? blockedIpv4(ipv4Of(g, h)) : true;
	}
	if (a === 0x100 && b === 0 && c === 0 && d === 0) return true;
	if (a === 0x2001 && (b === 0 || b === 0xdb8)) return true;
	if (a === 0x2002) return blockedIpv4(ipv4Of(b, c));
	return a < 0x2000 || a > 0x3fff;
}

/**
 * Whether an IP address is one the guard refuses to connect to.
 *
 * @param address - An IPv4 or IPv6 address.
 * @returns Whether it is refused; anything that is not an IP address is refused.
 */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return blockedIpv4(address);
	if (family === 6) return blockedIpv6(address);
	return true;
}

/** An address the guard checked, to pin the connection to. */
interface CheckedAddress {
	address: string;
	family: number;
}

/**
 * Resolves a host, giving up when the request's time limit fires.
 *
 * @param host - The host.
 * @param signal - The request's time limit.
 * @returns Every address it resolves to.
 */
async function resolveWithin(host: string, signal: AbortSignal): Promise<CheckedAddress[]> {
	const timedOut = (): Error =>
		Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" });
	if (signal.aborted) throw timedOut();
	let onAbort: (() => void) | null = null;
	const deadline = new Promise<never>((_resolve, reject) => {
		onAbort = () => {
			reject(timedOut());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([lookup(host, { all: true }), deadline]);
	} finally {
		if (onAbort !== null) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Checks a URL and answers the addresses the request may connect to.
 *
 * @param rawUrl - The URL.
 * @param signal - The request's time limit.
 * @param allowed - The hosts whose private addresses may be reached; the address check alone is
 *   skipped for them (the protocol and credential checks, the lookup and the pin stay).
 * @returns The addresses to pin the connection to.
 * @throws {BlockedUrlError} When the URL is refused.
 */
async function checkedAddresses(
	rawUrl: string,
	signal: AbortSignal,
	allowed: ReadonlySet<string>
): Promise<CheckedAddress[]> {
	if (!URL.canParse(rawUrl)) throw new BlockedUrlError("The URL is not a valid URL.");
	const url = new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlockedUrlError("Only http and https URLs are read.");
	}
	if (url.username !== "" || url.password !== "") {
		throw new BlockedUrlError("A URL with credentials is not read.");
	}
	const host = url.hostname.toLowerCase();
	const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	const mayBePrivate = allowed.has(host) || allowed.has(literal);
	if (isIP(literal) !== 0) {
		if (!mayBePrivate && isBlockedAddress(literal)) {
			throw new BlockedUrlError("The URL points to a private or reserved address.");
		}
		return [{ address: literal, family: isIP(literal) }];
	}
	let resolved: CheckedAddress[];
	try {
		resolved = await resolveWithin(host, signal);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		throw new BlockedUrlError(
			"The host could not be resolved.",
			typeof code === "string" && NAME_NOT_FOUND_CODES.has(code) ? "not_found" : "dns_unavailable"
		);
	}
	if (resolved.length === 0)
		throw new BlockedUrlError("The host could not be resolved.", "not_found");
	if (!mayBePrivate && resolved.some(({ address }) => isBlockedAddress(address))) {
		throw new BlockedUrlError("The URL resolves to a private or reserved address.");
	}
	return resolved.map(({ address, family }) => ({ address, family }));
}

/**
 * A one-request connection pool that connects ONLY to the checked addresses and never resolves the
 * host again, while the host name still names the TLS server and the `Host` header.
 *
 * @param addresses - The checked addresses.
 * @returns The dispatcher.
 */
function pinnedDispatcher(addresses: readonly CheckedAddress[]): Dispatcher {
	const pinned: LookupFunction = (_hostname, options, callback) => {
		if (options.all) {
			callback(null, [...addresses]);
		} else {
			const first = addresses[0];
			if (first === undefined) callback(new Error("No checked address."), "", 0);
			else callback(null, first.address, first.family);
		}
	};
	return new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10, connect: { lookup: pinned } });
}

/**
 * An undici response as a standard one, so a caller typed against the platform `fetch` gets a real
 * `Response`.
 *
 * @param response - The undici response.
 * @returns The standard response.
 * @throws {BlockedUrlError} When the status cannot be represented.
 */
function standardResponse(response: UndiciResponse): Response {
	if (response.status < 200 || response.status > 599) {
		throw new BlockedUrlError("The site answered a status this crawler cannot represent.");
	}
	const body =
		response.body instanceof ReadableStream && !NULL_BODY_STATUSES.has(response.status)
			? response.body
			: null;
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers([...response.headers])
	});
}

/**
 * The guarded crawler transport ({@link guardedFetch}), the private addresses of the hosts named in
 * `allowPrivateHosts` reachable. There is no unguarded mode: every request is still checked, looked up
 * and pinned.
 *
 * @param options - The hosts whose private addresses may be reached.
 * @returns The transport.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): SeoCrawlFetcher {
	const allowed = new Set([...(options.allowPrivateHosts ?? [])].map((host) => host.toLowerCase()));
	return async (url, init, timeoutMs) => {
		const signal = init.signal
			? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
		const addresses = await checkedAddresses(url, signal, allowed);
		const request = new Request(url, { ...init, signal });
		const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
		return standardResponse(
			await undiciFetch(request.url, {
				method: request.method,
				headers: [...request.headers],
				body,
				redirect: "manual",
				signal,
				dispatcher: pinnedDispatcher(addresses)
			})
		);
	};
}

/**
 * THE DEFAULT TRANSPORT of a standalone crawl (`crawlSite`) and of `readPage`: every request checked against
 * private, local and reserved addresses, its connection pinned to the addresses checked, its redirect
 * returned rather than followed, and cut at its timeout.
 */
export const guardedFetch: SeoCrawlFetcher = createGuardedFetch();
