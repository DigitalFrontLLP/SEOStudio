import type { SeoPageAmpError, SeoPageAmpFacts } from "./facts";

import { decompressText } from "./main-text";

/**
 * THE AMP CHECK: the official AMP validator (vendored, `./amp-validator.generated`, built by
 * `scripts/build-amp-validator.ts`) run over the HTML an AMP page served, exactly as AMP's own tools
 * validate it. Only pages that declare themselves AMP (`<html amp>`) are validated; the validator is
 * loaded on the first one, inside a `node:vm` context of its own, and kept. Its errors are kept (its
 * warnings are not problems); the rules judge them.
 */

/** The errors kept per page, the parameters kept per error, and the characters of each. */
const ERRORS = 10;
const PARAMS = 5;
const PARAM_CHARS = 120;

/** The validator's answer, as far as the check reads it. */
interface AmpValidation {
	status: string;
	errors: { severity: string; code: string; line: number; params: string[] }[];
}

/** What the loaded validator exposes. */
type ValidateString = (html: string, format: string) => unknown;

/** The validator, loaded once per process. */
let loading: Promise<ValidateString> | null = null;

/**
 * Whether a value is an object with string keys.
 *
 * @param value - The value.
 * @returns Whether it is.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The validator's answer read defensively.
 *
 * @param value - What `validateString` returned.
 * @returns The answer, or null when it is not one.
 */
function validationOf(value: unknown): AmpValidation | null {
	if (!isRecord(value) || typeof value.status !== "string" || !Array.isArray(value.errors))
		return null;
	const errors = value.errors.filter(isRecord).map((error) => ({
		severity: typeof error.severity === "string" ? error.severity : "",
		code: typeof error.code === "string" ? error.code : "UNKNOWN",
		line: typeof error.line === "number" ? error.line : 0,
		params: Array.isArray(error.params)
			? error.params.filter((param): param is string => typeof param === "string")
			: []
	}));
	return { status: value.status, errors };
}

/**
 * Loads the vendored validator into a context of its own.
 *
 * @returns Its `validateString`.
 */
async function loadValidator(): Promise<ValidateString> {
	const [{ ampValidatorScript }, vm] = await Promise.all([
		import("./amp-validator.generated"),
		import("node:vm")
	]);
	const sandbox = vm.createContext();
	new vm.Script(await decompressText(ampValidatorScript)).runInContext(sandbox);
	const amp: unknown = (sandbox as Record<string, unknown>).amp;
	const validator = isRecord(amp) ? amp.validator : undefined;
	if (!isRecord(validator) || typeof validator.validateString !== "function")
		throw new Error("The AMP validator did not load");
	const init = validator.init;
	if (typeof init === "function") await (init as () => Promise<unknown>).call(validator);
	const validate = validator.validateString as ValidateString;
	return (html, format) => validate.call(validator, html, format);
}

/**
 * The validator, loaded on first use; a failed load is tried again next time.
 *
 * @returns Its `validateString`.
 */
function validator(): Promise<ValidateString> {
	loading ??= loadValidator().catch((error: unknown) => {
		loading = null;
		throw error;
	});
	return loading;
}

/**
 * The most characters of HTML the validator reads: far above any AMP page (its own limits keep a page
 * small), and low enough that one hostile page cannot hold the process for seconds.
 */
export const SEO_AMP_MAX_CHARS = 1_000_000;

/**
 * Validates an AMP page's served HTML. A page larger than {@link SEO_AMP_MAX_CHARS} is not validated.
 *
 * @param html - The HTML as served.
 * @returns The validator's errors, or null when the validator could not run (or the page is too large).
 */
export async function ampFactsOf(html: string): Promise<SeoPageAmpFacts | null> {
	if (html.length > SEO_AMP_MAX_CHARS) return null;
	try {
		const validation = validationOf((await validator())(html, "AMP"));
		if (validation === null) return null;
		const errors = validation.errors.filter((error) => error.severity === "ERROR");
		return {
			errors: errors.slice(0, ERRORS).map((error): SeoPageAmpError => ({
				code: error.code.slice(0, 80),
				params: error.params.slice(0, PARAMS).map((param) => param.slice(0, PARAM_CHARS)),
				line: error.line
			})),
			errorCount: errors.length
		};
	} catch {
		return null;
	}
}
