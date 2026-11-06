import { CLI_VERSION } from "./version.js";

/** The SEOStudio address the CLI talks to when {@link API_URL_ENV} is not set. */
export const DEFAULT_API_URL = "https://seostudio.com";

/** The environment variable that points the CLI at another SEOStudio address. */
export const API_URL_ENV = "SEOSTUDIO_API_URL";

/** The header an API key travels in. */
export const API_KEY_HEADER = "x-api-key";

/** The longest one call to SEOStudio may take: a batch of readings is stored before it answers. */
const API_TIMEOUT_MS = 180_000;

/** One answer from SEOStudio: the HTTP status and the parsed JSON body (null when none). */
export interface ApiAnswer {
	status: number;
	body: unknown;
}

/** One call to the SEO routes: a path below `/api/seo`, JSON in and out. */
export type SeoApi = (
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown
) => Promise<ApiAnswer>;

/**
 * The SEOStudio address: {@link API_URL_ENV} when set, else {@link DEFAULT_API_URL}. Only https is
 * accepted, so an API key never travels in the clear.
 *
 * @param env - The process environment.
 * @returns The origin, without a trailing slash.
 * @throws When the address is not an https URL.
 */
export function apiOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const raw = env[API_URL_ENV]?.trim() || DEFAULT_API_URL;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`${API_URL_ENV} is not a URL.`);
	}
	if (parsed.protocol !== "https:") throw new Error(`${API_URL_ENV} must be an https address.`);
	return parsed.origin;
}

/**
 * The SEO routes reached with an API key. The key rides in {@link API_KEY_HEADER} only; it is never
 * part of a URL, a log line or an error message.
 *
 * @param options.origin - The SEOStudio origin.
 * @param options.key - The API key.
 * @param options.fetch - The transport; the global fetch by default.
 * @returns The caller.
 */
export function seoApi(options: { origin: string; key: string; fetch?: typeof fetch }): SeoApi {
	const transport = options.fetch ?? fetch;
	return async (method, path, body) => {
		const headers: Record<string, string> = {
			[API_KEY_HEADER]: options.key,
			Accept: "application/json",
			"User-Agent": `seostudio-cli/${CLI_VERSION}`
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const response = await transport(`${options.origin}/api/seo${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(API_TIMEOUT_MS)
		});
		const parsed: unknown = await response.json().catch(() => null);
		return { status: response.status, body: parsed };
	};
}
