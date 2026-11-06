/**
 * THE CHROME UX REPORT (CrUX), read for Core Web Vitals: real Chrome users' loading (LCP),
 * responsiveness (INP) and visual stability (CLS) at the 75th percentile, the same field data Search
 * Console's Core Web Vitals report shows.
 *
 * Two endpoints, both free with a Google API key:
 * - `records:queryRecord`: the latest 28 days, with the LCP subparts (time to first byte, resource
 *   load delay, resource load duration, element render delay) that say WHY a slow LCP is slow.
 * - `records:queryHistoryRecord`: the same metrics as weekly points (each a 28-day window, about 25).
 *
 * A URL is asked first; one with too little Chrome traffic answers 404, and the reader then shows the
 * origin's numbers, labelled as the whole site's. Pure apart from the injected transport: no database,
 * no environment.
 */

/** A calendar day, `YYYY-MM-DD`. */
type IsoDate = string;

/** Where the CrUX API answers. */
export const CRUX_ORIGIN = "https://chromeuxreport.googleapis.com";

/** The latest-28-days endpoint. */
export const CRUX_RECORD_URL = `${CRUX_ORIGIN}/v1/records:queryRecord`;

/** The weekly-history endpoint. */
export const CRUX_HISTORY_URL = `${CRUX_ORIGIN}/v1/records:queryHistoryRecord`;

/** How long one CrUX request is given before it is abandoned and counted as unreachable. */
export const CRUX_REQUEST_TIMEOUT_MS = 30_000;

/** How many weekly points the history asks for (CrUX's default, about six months). */
export const CRUX_HISTORY_PERIODS = 25;

/** The form factors read: phones first (the all-devices view hides mobile failures), then desktop. */
export const CRUX_FORM_FACTORS = ["PHONE", "DESKTOP"] as const;

/** One of {@link CRUX_FORM_FACTORS}. */
export type CruxFormFactor = (typeof CRUX_FORM_FACTORS)[number];

/** The three Core Web Vitals. */
export const SEO_VITALS_METRICS = ["lcp", "inp", "cls"] as const;

/** One of {@link SEO_VITALS_METRICS}. */
export type SeoVitalsMetric = (typeof SEO_VITALS_METRICS)[number];

/**
 * Google's thresholds at the 75th percentile: at or under `good` is good, over `poor` is poor, between
 * needs improvement. LCP and INP in milliseconds, CLS unitless.
 */
export const SEO_VITALS_THRESHOLDS: Readonly<
	Record<SeoVitalsMetric, { good: number; poor: number }>
> = {
	lcp: { good: 2500, poor: 4000 },
	inp: { good: 200, poor: 500 },
	cls: { good: 0.1, poor: 0.25 }
};

/** How a 75th percentile rates against {@link SEO_VITALS_THRESHOLDS}. */
export type SeoVitalsRating = "good" | "needs_improvement" | "poor";

/**
 * A week-over-week change counts as a REGRESSION when the 75th percentile got this much worse (0.2 is
 * 20%) AND it crossed a threshold into a worse rating.
 */
export const SEO_VITALS_REGRESSION_SHARE = 0.2;

/** The CrUX names of the metrics read. */
const CRUX_METRICS = {
	lcp: "largest_contentful_paint",
	inp: "interaction_to_next_paint",
	cls: "cumulative_layout_shift",
	fcp: "first_contentful_paint",
	ttfb: "experimental_time_to_first_byte"
} as const;

/** The CrUX names of the LCP subparts. */
const LCP_SUBPARTS = {
	ttfb: "largest_contentful_paint_image_time_to_first_byte",
	loadDelay: "largest_contentful_paint_image_resource_load_delay",
	loadDuration: "largest_contentful_paint_image_resource_load_duration",
	renderDelay: "largest_contentful_paint_image_element_render_delay"
} as const;

/** The LCP subparts at the 75th percentile, in milliseconds. */
export interface CruxLcpSubparts {
	ttfb: number | null;
	loadDelay: number | null;
	loadDuration: number | null;
	renderDelay: number | null;
}

/** One metric's good / needs improvement / poor shares (0 to 1). */
export interface CruxShares {
	good: number | null;
	needsImprovement: number | null;
	poor: number | null;
}

/** The latest 28 days of one URL or origin. */
export interface CruxReading {
	periodStart: IsoDate | null;
	periodEnd: IsoDate | null;
	lcpMs: number | null;
	inpMs: number | null;
	cls: number | null;
	fcpMs: number | null;
	ttfbMs: number | null;
	lcpSubparts: CruxLcpSubparts;
	shares: Partial<Record<SeoVitalsMetric, CruxShares>>;
}

/** One weekly point of the history. */
export interface CruxWeek {
	periodStart: IsoDate;
	periodEnd: IsoDate;
	lcpMs: number | null;
	inpMs: number | null;
	cls: number | null;
}

/** What one CrUX question is about: a page's URL or a whole origin. */
export type CruxTarget = { url: string } | { origin: string };

/** A `fetch`-shaped transport, injectable so tests never reach the network. */
export type CruxFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Thrown when CrUX refuses for a reason other than "no data" (a bad key, a quota, an outage). */
export class CruxRequestError extends Error {
	/** The HTTP status, or 0 when nothing answered. */
	readonly status: number;

	/**
	 * @param message - What went wrong, without the key.
	 * @param status - The HTTP status.
	 */
	constructor(message: string, status: number) {
		super(message);
		this.name = "CruxRequestError";
		this.status = status;
	}
}

/**
 * Whether a value is a plain object.
 *
 * @param value - The value.
 * @returns Whether it is one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A number CrUX sent as a number or a string (CLS arrives as `"0.05"`).
 *
 * @param value - The raw value.
 * @returns The number, or null.
 */
function numberOf(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * A CrUX date (`{ year, month, day }`) as a calendar day.
 *
 * @param value - The raw date.
 * @returns The day, or null.
 */
function dayOf(value: unknown): IsoDate | null {
	if (!isRecord(value)) return null;
	const year = numberOf(value.year);
	const month = numberOf(value.month);
	const day = numberOf(value.day);
	if (year === null || month === null || day === null) return null;
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The 75th percentile of one metric of a record.
 *
 * @param metrics - The record's metrics.
 * @param name - The CrUX metric name.
 * @returns The value, or null.
 */
function p75(metrics: Record<string, unknown>, name: string): number | null {
	const metric = metrics[name];
	if (!isRecord(metric) || !isRecord(metric.percentiles)) return null;
	return numberOf(metric.percentiles.p75);
}

/**
 * One metric's three histogram bins as shares.
 *
 * @param metrics - The record's metrics.
 * @param name - The CrUX metric name.
 * @returns The shares, or null when the metric carries no histogram.
 */
function sharesOf(metrics: Record<string, unknown>, name: string): CruxShares | null {
	const metric = metrics[name];
	if (!isRecord(metric) || !Array.isArray(metric.histogram)) return null;
	const [good, needs, poor] = metric.histogram.map((bin: unknown) =>
		isRecord(bin) ? numberOf(bin.density) : null
	);
	return { good: good ?? null, needsImprovement: needs ?? null, poor: poor ?? null };
}

/**
 * The body of a CrUX question.
 *
 * @param target - The URL or origin.
 * @param formFactor - The form factor.
 * @param history - Whether it asks the history endpoint (which takes a period count).
 * @returns The serialized body.
 */
export function cruxRequestBody(
	target: CruxTarget,
	formFactor: CruxFormFactor,
	history: boolean
): string {
	return JSON.stringify({
		...target,
		formFactor,
		...(history ? { collectionPeriodCount: CRUX_HISTORY_PERIODS } : {})
	});
}

/**
 * Reads a `records:queryRecord` answer.
 *
 * @param body - The decoded answer.
 * @returns The reading, or null when the answer carries no record.
 */
export function parseCruxRecord(body: unknown): CruxReading | null {
	if (!isRecord(body) || !isRecord(body.record)) return null;
	const record = body.record;
	const metrics = isRecord(record.metrics) ? record.metrics : {};
	const period = isRecord(record.collectionPeriod) ? record.collectionPeriod : {};
	const shares: Partial<Record<SeoVitalsMetric, CruxShares>> = {};
	for (const metric of SEO_VITALS_METRICS) {
		const found = sharesOf(metrics, CRUX_METRICS[metric]);
		if (found !== null) shares[metric] = found;
	}
	return {
		periodStart: dayOf(period.firstDate),
		periodEnd: dayOf(period.lastDate),
		lcpMs: p75(metrics, CRUX_METRICS.lcp),
		inpMs: p75(metrics, CRUX_METRICS.inp),
		cls: p75(metrics, CRUX_METRICS.cls),
		fcpMs: p75(metrics, CRUX_METRICS.fcp),
		ttfbMs: p75(metrics, CRUX_METRICS.ttfb),
		lcpSubparts: {
			ttfb: p75(metrics, LCP_SUBPARTS.ttfb),
			loadDelay: p75(metrics, LCP_SUBPARTS.loadDelay),
			loadDuration: p75(metrics, LCP_SUBPARTS.loadDuration),
			renderDelay: p75(metrics, LCP_SUBPARTS.renderDelay)
		},
		shares
	};
}

/**
 * Reads a `records:queryHistoryRecord` answer into weekly points, oldest first. A week whose every
 * metric is missing is dropped.
 *
 * @param body - The decoded answer.
 * @returns The weeks.
 */
export function parseCruxHistory(body: unknown): CruxWeek[] {
	if (!isRecord(body) || !isRecord(body.record)) return [];
	const record = body.record;
	const periods = Array.isArray(record.collectionPeriods) ? record.collectionPeriods : [];
	const metrics = isRecord(record.metrics) ? record.metrics : {};
	const series = (name: string): unknown[] => {
		const metric = metrics[name];
		if (!isRecord(metric) || !isRecord(metric.percentilesTimeseries)) return [];
		const values = metric.percentilesTimeseries.p75s;
		return Array.isArray(values) ? values : [];
	};
	const lcp = series(CRUX_METRICS.lcp);
	const inp = series(CRUX_METRICS.inp);
	const cls = series(CRUX_METRICS.cls);
	return periods.flatMap((period: unknown, at: number): CruxWeek[] => {
		if (!isRecord(period)) return [];
		const periodStart = dayOf(period.firstDate);
		const periodEnd = dayOf(period.lastDate);
		if (periodStart === null || periodEnd === null) return [];
		const week = {
			periodStart,
			periodEnd,
			lcpMs: numberOf(lcp[at]),
			inpMs: numberOf(inp[at]),
			cls: numberOf(cls[at])
		};
		return week.lcpMs === null && week.inpMs === null && week.cls === null ? [] : [week];
	});
}

/**
 * Asks CrUX one question.
 *
 * @param params.fetch - The transport.
 * @param params.apiKey - The Google API key (sent as a header, never in the URL).
 * @param params.endpoint - {@link CRUX_RECORD_URL} or {@link CRUX_HISTORY_URL}.
 * @param params.target - The URL or origin.
 * @param params.formFactor - The form factor.
 * @returns The decoded answer, or null when CrUX holds no data for the target (404).
 * @throws {CruxRequestError} On any other refusal.
 */
async function askCrux(params: {
	fetch: CruxFetch;
	apiKey: string;
	endpoint: string;
	target: CruxTarget;
	formFactor: CruxFormFactor;
}): Promise<unknown> {
	let response: Response;
	try {
		response = await params.fetch(params.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", "x-goog-api-key": params.apiKey },
			body: cruxRequestBody(params.target, params.formFactor, params.endpoint === CRUX_HISTORY_URL),
			signal: AbortSignal.timeout(CRUX_REQUEST_TIMEOUT_MS)
		});
	} catch {
		throw new CruxRequestError("The Chrome UX Report could not be reached.", 0);
	}
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new CruxRequestError(
			`The Chrome UX Report refused the request (${String(response.status)}).`,
			response.status
		);
	}
	try {
		return await response.json();
	} catch {
		throw new CruxRequestError("The Chrome UX Report could not be reached.", 0);
	}
}

/**
 * The latest 28 days of a URL or origin.
 *
 * @param params - The transport, the key, the target and the form factor.
 * @returns The reading, or null when CrUX holds no data for it.
 * @throws {CruxRequestError} When CrUX refuses for another reason.
 */
export async function fetchCruxRecord(params: {
	fetch: CruxFetch;
	apiKey: string;
	target: CruxTarget;
	formFactor: CruxFormFactor;
}): Promise<CruxReading | null> {
	const body = await askCrux({ ...params, endpoint: CRUX_RECORD_URL });
	return body === null ? null : parseCruxRecord(body);
}

/**
 * The weekly history of a URL or origin.
 *
 * @param params - The transport, the key, the target and the form factor.
 * @returns The weeks, oldest first; none when CrUX holds no data for it.
 * @throws {CruxRequestError} When CrUX refuses for another reason.
 */
export async function fetchCruxHistory(params: {
	fetch: CruxFetch;
	apiKey: string;
	target: CruxTarget;
	formFactor: CruxFormFactor;
}): Promise<CruxWeek[]> {
	const body = await askCrux({ ...params, endpoint: CRUX_HISTORY_URL });
	return body === null ? [] : parseCruxHistory(body);
}

/**
 * How a 75th percentile rates.
 *
 * @param metric - The metric.
 * @param value - Its 75th percentile.
 * @returns The rating, or null without a value.
 */
export function rateVital(metric: SeoVitalsMetric, value: number | null): SeoVitalsRating | null {
	if (value === null) return null;
	const { good, poor } = SEO_VITALS_THRESHOLDS[metric];
	if (value <= good) return "good";
	return value > poor ? "poor" : "needs_improvement";
}

/**
 * Whether a target passes the Core Web Vitals assessment: every metric it has a value for is good,
 * and it has LCP and CLS at least (INP is missing on pages with too few interactions). A metric
 * measured as not good fails it whatever else is missing; null only when every measured metric is
 * good but LCP or CLS is missing, so the target has too little data to judge.
 *
 * @param values - The 75th percentiles.
 * @returns Whether it passes, or null.
 */
export function passesVitals(values: {
	lcpMs: number | null;
	inpMs: number | null;
	cls: number | null;
}): boolean | null {
	const ratings = [
		rateVital("lcp", values.lcpMs),
		rateVital("inp", values.inpMs),
		rateVital("cls", values.cls)
	];
	if (ratings.some((rating) => rating !== null && rating !== "good")) return false;
	if (values.lcpMs === null || values.cls === null) return null;
	return true;
}

/** How bad each rating is, for "got worse". */
const RATING_RANK: Readonly<Record<SeoVitalsRating, number>> = {
	good: 0,
	needs_improvement: 1,
	poor: 2
};

/** One week-over-week regression. */
export interface SeoVitalsRegression {
	/** The last day of the worse week's window: the day the change is marked on. */
	date: IsoDate;
	metric: SeoVitalsMetric;
	/** The 75th percentile the week before. */
	before: number;
	/** The 75th percentile now. */
	after: number;
}

/**
 * The week-over-week regressions of a history: a metric whose 75th percentile got more than
 * {@link SEO_VITALS_REGRESSION_SHARE} worse than the week before AND crossed a threshold into a worse
 * rating (good to needs improvement, needs improvement to poor, or good to poor).
 *
 * @param weeks - The weekly points, in any order.
 * @returns The regressions, oldest first.
 */
export function detectVitalsRegressions(weeks: readonly CruxWeek[]): SeoVitalsRegression[] {
	const sorted = [...weeks].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
	const found: SeoVitalsRegression[] = [];
	for (let at = 1; at < sorted.length; at += 1) {
		const before = sorted[at - 1];
		const after = sorted[at];
		if (before === undefined || after === undefined) continue;
		for (const metric of SEO_VITALS_METRICS) {
			const value = (week: CruxWeek): number | null =>
				metric === "lcp" ? week.lcpMs : metric === "inp" ? week.inpMs : week.cls;
			const was = value(before);
			const now = value(after);
			if (was === null || now === null || was <= 0) continue;
			if (now <= was * (1 + SEO_VITALS_REGRESSION_SHARE)) continue;
			const wasRating = rateVital(metric, was);
			const nowRating = rateVital(metric, now);
			if (wasRating === null || nowRating === null) continue;
			if (RATING_RANK[nowRating] <= RATING_RANK[wasRating]) continue;
			found.push({ date: after.periodEnd, metric, before: was, after: now });
		}
	}
	return found;
}

/** The LCP subpart that takes the largest share of a slow LCP, and that share. */
export interface SeoLcpBottleneck {
	part: keyof CruxLcpSubparts;
	/** Its 75th percentile, in milliseconds. */
	ms: number;
	/** Its share of the LCP (0 to 1). */
	share: number;
}

/**
 * The LCP subpart worth fixing first: the one taking at least 40% of an LCP that is not good. Null
 * while the LCP is good or no subpart dominates.
 *
 * @param lcpMs - The LCP's 75th percentile.
 * @param subparts - The subparts' 75th percentiles.
 * @returns The bottleneck, or null.
 */
export function lcpBottleneck(
	lcpMs: number | null,
	subparts: CruxLcpSubparts
): SeoLcpBottleneck | null {
	if (lcpMs === null || lcpMs <= 0 || rateVital("lcp", lcpMs) === "good") return null;
	let best: SeoLcpBottleneck | null = null;
	for (const part of Object.keys(LCP_SUBPARTS) as (keyof CruxLcpSubparts)[]) {
		const ms = subparts[part];
		if (ms === null) continue;
		const share = ms / lcpMs;
		if (share >= 0.4 && (best === null || share > best.share)) best = { part, ms, share };
	}
	return best;
}
