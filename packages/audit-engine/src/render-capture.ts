import type {
	SeoCaptureBox,
	SeoCaptureCover,
	SeoCaptureTarget,
	SeoRenderCapture,
	SeoRenderCaptureResult
} from "./types";

/**
 * THE CONTENT SCREENSHOT, inside a render (`./render-cdp`): once the page settled, its cookie banner is
 * dismissed (the consent script handed in, DuckDuckGo's autoconsent set to reject, then a built-in pass
 * that clicks a "reject" button inside a consent box and hides what is left of it), the focus element is
 * scrolled into view and measured, the elements to mark and to blur are measured (emails, phone numbers
 * and filled form fields always), and one PNG is captured of the focus with a margin (or of the first
 * screen). Boxes are answered in the shot's own pixels, so the annotations are drawn exactly on the
 * elements. A fixed or sticky element lying over the focus or a marked element (a chat bubble, a promo
 * widget) is named, so the proof it hides is never passed as shown; one named in the mask is hidden.
 * Pure apart from the DevTools session: no Node, no Electron, no Playwright. Logged-out
 * public pages only: the render never signs in anywhere.
 */

/** The margin around the focus element, in CSS pixels. */
const FOCUS_MARGIN = 24;

/** The shortest shot of a focus, in CSS pixels: a heading alone is grown to show what follows it. */
const MIN_FOCUS_SHOT_HEIGHT = 480;

/** The tallest shot, in CSS pixels (a page that never ends is cut here, never captured whole). */
const MAX_SHOT_HEIGHT = 2_400;

/** The widest shot, in CSS pixels. */
const MAX_SHOT_WIDTH = 2_000;

/** The most pixels one shot's PNG holds; a larger region is captured at a lower scale. */
export const SEO_SHOT_MAX_PIXELS = 12_000_000;

/** How long the consent script may work, in ms. */
const CONSENT_MS = 6_000;

/** How long to wait after a scroll for lazy images and animations, in ms. */
const SETTLE_MS = 800;

/** How long one DevTools call may take, in ms. */
const CALL_MS = 8_000;

/** What the capture needs from the render around it. */
export interface SeoCaptureIo {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

/** The built-in dismissal: click a reject button inside a consent box, then hide any consent box left. */
const DISMISS_SCRIPT = `(() => {
	const BOX = /(cookie|consent|gdpr|privacy|cmp|onetrust|didomi|usercentrics|cookiebot|truste|iubenda|quantcast|osano|termly)/i;
	const REJECT = /^(reject( all)?|decline( all)?|deny( all)?|refuse( all)?|disagree|only (necessary|essential)( cookies)?|necessary only|essential only|use necessary cookies only|continue without accepting|ablehnen|alle ablehnen|refuser|tout refuser|rechazar( todo)?|rifiuta( tutto)?|weigeren|alles weigeren|odrzuć|rejeitar)$/i;
	const inBox = (el) => { for (let at = el; at && at !== document.body; at = at.parentElement) { if (BOX.test((at.id || "") + " " + (typeof at.className === "string" ? at.className : ""))) return at; } return null; };
	let clicked = false;
	for (const el of Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')).slice(0, 3000)) {
		const text = ((el.innerText || el.value || el.getAttribute("aria-label") || "") + "").trim().replace(/\\s+/g, " ");
		if (text.length > 60 || !REJECT.test(text)) continue;
		if (!inBox(el) && !el.closest('[role="dialog"], [aria-modal="true"]')) continue;
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue;
		try { el.click(); clicked = true; break; } catch (e) {}
	}
	let hidden = 0;
	for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 6000)) {
		const style = getComputedStyle(el);
		if (style.position !== "fixed" && style.position !== "sticky") continue;
		const tag = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
		const text = (el.innerText || "").slice(0, 600);
		if (BOX.test(tag) || (/cookie/i.test(text) && el.getBoundingClientRect().height < window.innerHeight * 0.9)) {
			el.style.setProperty("display", "none", "important");
			hidden += 1;
		}
	}
	document.documentElement.style.setProperty("overflow", "auto", "important");
	if (document.body) document.body.style.setProperty("overflow", "auto", "important");
	return clicked || hidden > 0;
})()`;

/** The state of the autoconsent run, read from the page. */
const CONSENT_STATE = `(() => {
	const run = window.autoconsentStandalone;
	if (!run) return "absent";
	const types = run.messages.map((message) => message && message.type);
	if (types.includes("autoconsentDone") || types.includes("optOutResult")) return "done";
	if (types.includes("autoconsentError")) return "error";
	if (types.includes("cmpDetected") || types.includes("popupFound")) return "working";
	return "looking";
})()`;

/**
 * The in-page measuring script: scrolls the focus into view and answers every box in page coordinates.
 *
 * @param capture - What to measure.
 * @param scroll - Whether to scroll the focus into view (the first pass) or only measure (the second).
 * @returns The script.
 */
function measureScript(capture: SeoRenderCapture, scroll: boolean): string {
	const input = JSON.stringify({
		focus: capture.focus,
		highlights: capture.highlights,
		mask: capture.mask,
		brand: capture.brand && !scroll,
		scroll
	});
	return `(() => {
	const input = ${input};
	const visible = (el) => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
	const find = (target) => {
		if (!target) return null;
		if (target.selector) { try { const all = Array.from(document.querySelectorAll(target.selector)); const hit = all.find(visible); if (hit) return hit; } catch (e) {} }
		if (target.text) {
			const want = String(target.text).toLowerCase().replace(/\\s+/g, " ").trim();
			let best = null; let bestArea = Infinity;
			for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 8000)) {
				if (!visible(el)) continue;
				const text = (el.innerText || "").toLowerCase().replace(/\\s+/g, " ");
				if (!text.includes(want)) continue;
				const rect = el.getBoundingClientRect();
				const area = rect.width * rect.height;
				if (area < bestArea) { best = el; bestArea = area; }
			}
			return best;
		}
		return null;
	};
	const box = (rect) => ({ x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height });
	const pinned = (el) => { const position = getComputedStyle(el).position; return position === "fixed" || position === "sticky"; };
	if (input.scroll) { for (const selector of input.mask) { try { for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 50)) if (pinned(el)) el.style.setProperty("display", "none", "important"); } catch (e) {} } }
	const focus = find(input.focus);
	if (input.scroll) {
		if (focus) focus.scrollIntoView({ block: "center", inline: "nearest" }); else window.scrollTo(0, 0);
		return { scrolled: true };
	}
	const masks = [];
	for (const selector of input.mask) { try { for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 50)) if (visible(el)) masks.push(box(el.getBoundingClientRect())); } catch (e) {} }
	for (const el of Array.from(document.querySelectorAll('input[type="email"], input[type="tel"], input[type="password"], input[autocomplete*="email"], input[name*="email" i], input[name*="phone" i]')).slice(0, 50)) {
		if (visible(el) && (el.value || "").length > 0) masks.push(box(el.getBoundingClientRect()));
	}
	const PRIVATE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}|\\+?\\d[\\d ().-]{7,}\\d/gi;
	const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
	let seen = 0;
	for (let node = walker.nextNode(); node && seen < 20000 && masks.length < 200; node = walker.nextNode()) {
		seen += 1;
		const text = node.nodeValue || "";
		if (text.length < 8) continue;
		PRIVATE.lastIndex = 0;
		for (let match = PRIVATE.exec(text); match; match = PRIVATE.exec(text)) {
			if (/^\\+?[\\d ().-]+$/.test(match[0]) && match[0].replace(/\\D/g, "").length < 9) continue;
			const range = document.createRange();
			range.setStart(node, match.index);
			range.setEnd(node, match.index + match[0].length);
			for (const rect of Array.from(range.getClientRects())) if (rect.width > 0) masks.push(box(rect));
		}
	}
	const marked = input.highlights.map(find);
	const overlays = [];
	for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 8000)) {
		if (!pinned(el) || !visible(el) || Number(getComputedStyle(el).opacity) === 0) continue;
		if (overlays.some((outer) => outer.contains(el))) continue;
		overlays.push(el);
		if (overlays.length >= 40) break;
	}
	const named = (el) => { if (el.id) return "#" + CSS.escape(el.id); const classes = (typeof el.className === "string" ? el.className : "").trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((name) => "." + CSS.escape(name)).join(""); return el.tagName.toLowerCase() + classes; };
	const covered = [];
	const cover = (target, el) => {
		if (!el) return;
		const rect = el.getBoundingClientRect();
		for (const over of overlays) {
			if (over.contains(el) || el.contains(over)) continue;
			const top = over.getBoundingClientRect();
			const width = Math.min(rect.right, top.right, window.innerWidth) - Math.max(rect.left, top.left, 0);
			const height = Math.min(rect.bottom, top.bottom, window.innerHeight) - Math.max(rect.top, top.top, 0);
			if (width < 4 || height < 4 || covered.length >= 20) continue;
			covered.push({ target, selector: named(over).slice(0, 200), text: (over.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60) });
		}
	};
	cover("focus", focus);
	marked.forEach((el, index) => cover(index, el));
	const answer = {
		focus: focus ? box(focus.getBoundingClientRect()) : null,
		highlights: marked.map((el) => (el ? box(el.getBoundingClientRect()) : null)),
		masks,
		covered,
		page: { width: Math.max(document.documentElement.scrollWidth, window.innerWidth), height: Math.max(document.documentElement.scrollHeight, window.innerHeight) },
		view: { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight },
		brand: null
	};
	if (input.brand) {
		const logos = [];
		const add = (value) => { try { if (!value || String(value).startsWith("data:")) return; const url = new URL(String(value), location.href).href; if (/^https?:/.test(url) && !logos.includes(url)) logos.push(url); } catch (e) {} };
		const walk = (value) => { if (!value || typeof value !== "object") return; if (Array.isArray(value)) { value.forEach(walk); return; } if (value.logo) add(typeof value.logo === "string" ? value.logo : (value.logo.url || value.logo.contentUrl)); for (const key of Object.keys(value)) if (typeof value[key] === "object") walk(value[key]); };
		for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) { try { walk(JSON.parse(script.textContent || "")); } catch (e) {} }
		for (const img of Array.from(document.querySelectorAll("header img, nav img, img")).slice(0, 300)) {
			const named = [img.getAttribute("src"), img.getAttribute("alt"), img.id, typeof img.className === "string" ? img.className : "", img.parentElement ? (img.parentElement.id + " " + (typeof img.parentElement.className === "string" ? img.parentElement.className : "")) : ""].join(" ");
			if (/logo/i.test(named) && visible(img)) add(img.currentSrc || img.src);
		}
		for (const link of Array.from(document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="icon"]'))) add(link.getAttribute("href"));
		const theme = document.querySelector('meta[name="theme-color"]');
		const cssColors = [];
		const root = getComputedStyle(document.documentElement);
		const names = new Set();
		for (const sheet of Array.from(document.styleSheets).slice(0, 30)) {
			let rules = [];
			try { rules = Array.from(sheet.cssRules || []).slice(0, 4000); } catch (e) { continue; }
			for (const rule of rules) {
				if (!rule.style || !/(^|,)\\s*(:root|html)\\b/.test(rule.selectorText || "")) continue;
				for (const name of Array.from(rule.style)) if (name.startsWith("--") && /(primary|brand|accent|main|theme|cta)/i.test(name) && !/(text|foreground|fg|bg-?light|border|shadow)/i.test(name)) names.add(name);
			}
		}
		for (const name of Array.from(names).slice(0, 40)) { const value = root.getPropertyValue(name).trim(); if (value) cssColors.push({ name, value }); }
		const counts = new Map();
		for (const el of Array.from(document.querySelectorAll('a, button, [role="button"]')).slice(0, 2000)) {
			const named = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
			if (el.tagName === "A" && !/(btn|button|cta|primary)/i.test(named)) continue;
			if (!visible(el)) continue;
			const color = getComputedStyle(el).backgroundColor;
			if (!color || color === "transparent" || /rgba\\([^)]*,\\s*0\\)$/.test(color)) continue;
			counts.set(color, (counts.get(color) || 0) + 1);
		}
		answer.brand = { logos: logos.slice(0, 8), themeColor: theme ? theme.getAttribute("content") : null, cssColors: cssColors.slice(0, 20), ctaColors: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map((entry) => entry[0]) };
	}
	return answer;
})()`;
}

/** A rectangle as the measuring script answers it, in page coordinates. */
interface PageBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A value as a page box, or null.
 *
 * @param value - The value.
 * @returns The box.
 */
function pageBox(value: unknown): PageBox | null {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	const [x, y, width, height] = [entry.x, entry.y, entry.width, entry.height];
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number"
	)
		return null;
	if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
	return { x, y, width, height };
}

/**
 * The value a `Runtime.evaluate` answered.
 *
 * @param answer - The CDP answer.
 * @returns The value.
 */
function evaluated(answer: unknown): unknown {
	if (typeof answer !== "object" || answer === null) return null;
	const result = (answer as { result?: { value?: unknown } }).result;
	return result?.value ?? null;
}

/**
 * A box of the page, in the shot's pixels, cut to the shot; null when nothing of it is inside.
 *
 * @param box - The page box.
 * @param clip - The shot's region of the page.
 * @param scale - Pixels per CSS pixel.
 * @returns The box.
 */
function inShot(box: PageBox, clip: PageBox, scale: number): SeoCaptureBox | null {
	const left = Math.max(box.x, clip.x);
	const top = Math.max(box.y, clip.y);
	const right = Math.min(box.x + box.width, clip.x + clip.width);
	const bottom = Math.min(box.y + box.height, clip.y + clip.height);
	if (right - left < 1 || bottom - top < 1) return null;
	return {
		x: Math.round((left - clip.x) * scale),
		y: Math.round((top - clip.y) * scale),
		width: Math.round((right - left) * scale),
		height: Math.round((bottom - top) * scale)
	};
}

/**
 * The region of the page a shot covers: the focus and every marked element found with a margin, grown
 * to at least {@link MIN_FOCUS_SHOT_HEIGHT} tall (a focus on a heading shows what follows it) and at
 * most {@link MAX_SHOT_HEIGHT} tall; else the screen as it is (or the whole page up to that height).
 *
 * @param focus - The focus box, or null.
 * @param page - The page's size.
 * @param view - The visible screen.
 * @param fullPage - Whether to take the whole page when there is no focus.
 * @param marks - The boxes of the elements to mark that were found (kept inside the shot).
 * @returns The region.
 */
export function seoShotRegion(
	focus: PageBox | null,
	page: { width: number; height: number },
	view: PageBox,
	fullPage: boolean,
	marks: readonly PageBox[] = []
): PageBox {
	if (focus === null) {
		const height = Math.min(fullPage ? page.height : view.height, MAX_SHOT_HEIGHT);
		return { x: 0, y: fullPage ? 0 : view.y, width: Math.min(view.width, MAX_SHOT_WIDTH), height };
	}
	const boxes = [focus, ...marks];
	const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - FOCUS_MARGIN);
	const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - FOCUS_MARGIN);
	const right = Math.min(
		Math.max(page.width, view.width),
		Math.max(...boxes.map((box) => box.x + box.width)) + FOCUS_MARGIN,
		x + MAX_SHOT_WIDTH
	);
	const wanted = Math.max(
		Math.max(...boxes.map((box) => box.y + box.height)) + FOCUS_MARGIN,
		y + MIN_FOCUS_SHOT_HEIGHT
	);
	const bottom = Math.min(page.height, wanted, y + MAX_SHOT_HEIGHT);
	return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/**
 * The scale a region is captured at: the render's pixel density, lowered so the PNG holds at most
 * {@link SEO_SHOT_MAX_PIXELS}.
 *
 * @param region - The region, in CSS pixels.
 * @param density - The render's pixel density.
 * @returns The capture's scale (CDP `clip.scale`, relative to the density) and the pixels per CSS pixel.
 */
export function seoShotScale(
	region: { width: number; height: number },
	density: number
): { clip: number; pixels: number } {
	const full = region.width * region.height * density * density;
	const clip = full <= SEO_SHOT_MAX_PIXELS ? 1 : Math.sqrt(SEO_SHOT_MAX_PIXELS / full);
	return { clip, pixels: density * clip };
}

/**
 * Runs one DevTools call, or answers null when it fails or does not answer in time.
 *
 * @param io - The session.
 * @param method - The method.
 * @param params - Its parameters.
 * @param ms - The longest wait.
 * @returns The answer, or null.
 */
async function call(
	io: SeoCaptureIo,
	method: string,
	params: Record<string, unknown>,
	ms: number
): Promise<unknown> {
	const late = Symbol("late");
	const answer = await Promise.race([
		io.send(method, params).catch(() => null),
		io.sleep(Math.max(0, ms)).then(() => late)
	]);
	return answer === late ? null : answer;
}

/**
 * Dismisses the page's cookie banner: the consent script first (its own detection and opt-out, given a
 * few seconds), then the built-in pass.
 *
 * @param io - The session.
 * @param script - The consent script, or null.
 * @param deadline - When the capture must be done.
 * @returns What happened.
 */
async function dismissConsent(
	io: SeoCaptureIo,
	script: string | null,
	deadline: number
): Promise<SeoRenderCaptureResult["consent"]> {
	let outcome: SeoRenderCaptureResult["consent"] = "none";
	if (script !== null) {
		await call(io, "Runtime.evaluate", { expression: script, returnByValue: true }, CALL_MS);
		const until = Math.min(deadline - 4_000, io.now() + CONSENT_MS);
		let looking = 0;
		while (io.now() < until) {
			await io.sleep(400);
			const state = evaluated(
				await call(
					io,
					"Runtime.evaluate",
					{ expression: CONSENT_STATE, returnByValue: true },
					2_000
				)
			);
			if (state === "done") {
				outcome = "dismissed";
				break;
			}
			if (state === "error") {
				outcome = "failed";
				break;
			}
			if (state === "looking" || state === "absent") looking += 1;
			if (looking >= 6) break;
		}
	}
	const built = evaluated(
		await call(io, "Runtime.evaluate", { expression: DISMISS_SCRIPT, returnByValue: true }, CALL_MS)
	);
	if (built === true && outcome === "none") outcome = "dismissed";
	await io.sleep(SETTLE_MS);
	return outcome;
}

/**
 * TAKES THE CONTENT SCREENSHOT on a settled page.
 *
 * @param io - The page's DevTools session, a pause and a clock.
 * @param capture - What to capture.
 * @param deadline - When it must be done (the render's hard deadline).
 * @param scale - The render's pixel density.
 * @returns The shot and its boxes; `png` null when it could not be taken.
 */
export async function seoCaptureInPage(
	io: SeoCaptureIo,
	capture: SeoRenderCapture,
	deadline: number,
	scale: number
): Promise<SeoRenderCaptureResult> {
	const empty: SeoRenderCaptureResult = {
		png: null,
		width: 0,
		height: 0,
		focusFound: false,
		highlights: [],
		masks: [],
		consent: "none",
		covered: [],
		brand: null
	};
	const consent = await dismissConsent(io, capture.consentScript, deadline);
	await call(
		io,
		"Runtime.evaluate",
		{ expression: measureScript(capture, true), returnByValue: true },
		CALL_MS
	);
	await io.sleep(SETTLE_MS);
	const measured = evaluated(
		await call(
			io,
			"Runtime.evaluate",
			{ expression: measureScript(capture, false), returnByValue: true },
			CALL_MS
		)
	);
	if (typeof measured !== "object" || measured === null) return { ...empty, consent };
	const facts = measured as Record<string, unknown>;
	const page = pageBox({ x: 0, y: 0, ...(facts.page as object) });
	const view = pageBox(facts.view);
	if (page === null || view === null) return { ...empty, consent };
	const focus = pageBox(facts.focus);
	const marked = (
		Array.isArray(facts.highlights) ? facts.highlights.slice(0, SEO_CAPTURE_MAX_TARGETS) : []
	)
		.map((value) => pageBox(value))
		.filter((box): box is PageBox => box !== null);
	const region = seoShotRegion(focus, page, view, capture.fullPage, marked);
	const scaled = seoShotScale(region, scale);
	if (deadline - io.now() < 1_000) return { ...empty, consent };
	const shot = await call(
		io,
		"Page.captureScreenshot",
		{
			format: "png",
			clip: { ...region, scale: scaled.clip },
			captureBeyondViewport: true,
			fromSurface: true
		},
		Math.min(15_000, deadline - io.now())
	);
	const data = typeof shot === "object" && shot !== null ? (shot as { data?: unknown }).data : null;
	const pixels = scaled.pixels;
	const highlights = Array.isArray(facts.highlights)
		? facts.highlights.slice(0, SEO_CAPTURE_MAX_TARGETS).map((value) => {
				const box = pageBox(value);
				return box === null ? null : inShot(box, region, pixels);
			})
		: [];
	const masks = (Array.isArray(facts.masks) ? facts.masks.slice(0, SEO_CAPTURE_MAX_MASK_BOXES) : [])
		.map((value) => pageBox(value))
		.map((box) => (box === null ? null : inShot(box, region, pixels)))
		.filter((box): box is SeoCaptureBox => box !== null);
	const brand = parseBrand(facts.brand);
	return {
		png: typeof data === "string" && data.length > 0 ? data : null,
		width: Math.round(region.width * pixels),
		height: Math.round(region.height * pixels),
		focusFound: focus !== null,
		highlights,
		masks,
		consent,
		covered: parseCovered(
			facts.covered,
			Array.isArray(facts.highlights) ? facts.highlights.length : 0
		),
		brand
	};
}

/**
 * The covering elements the page answered, checked.
 *
 * @param value - What the page answered.
 * @param marks - How many marked elements were asked for.
 * @returns The covers.
 */
function parseCovered(value: unknown, marks: number): SeoCaptureCover[] {
	if (!Array.isArray(value)) return [];
	const out: SeoCaptureCover[] = [];
	for (const item of value.slice(0, 20)) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as Record<string, unknown>;
		const target = entry.target;
		const valid =
			target === "focus" ||
			(typeof target === "number" && Number.isInteger(target) && target >= 0 && target < marks);
		if (!valid || typeof entry.selector !== "string" || entry.selector === "") continue;
		out.push({
			target,
			selector: entry.selector.slice(0, 200),
			text: typeof entry.text === "string" ? entry.text.slice(0, 60) : ""
		});
	}
	return out;
}

/**
 * The brand probe's answer, checked.
 *
 * @param value - What the page answered.
 * @returns The brand facts, or null.
 */
function parseBrand(value: unknown): SeoRenderCaptureResult["brand"] {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	const strings = (list: unknown, max: number): string[] =>
		Array.isArray(list)
			? list
					.filter((item): item is string => typeof item === "string" && item.length <= 2_000)
					.slice(0, max)
			: [];
	const cssColors = Array.isArray(entry.cssColors)
		? entry.cssColors
				.filter(
					(item): item is { name: string; value: string } =>
						typeof item === "object" &&
						item !== null &&
						typeof (item as { name?: unknown }).name === "string" &&
						typeof (item as { value?: unknown }).value === "string"
				)
				.slice(0, 20)
				.map((item) => ({ name: item.name.slice(0, 100), value: item.value.slice(0, 100) }))
		: [];
	return {
		logos: strings(entry.logos, 8),
		themeColor: typeof entry.themeColor === "string" ? entry.themeColor.slice(0, 60) : null,
		cssColors,
		ctaColors: strings(entry.ctaColors, 6).map((color) => color.slice(0, 60))
	};
}

/** The most elements one shot marks, the most selectors it blurs, and the most boxes it blurs. */
export const SEO_CAPTURE_MAX_TARGETS = 9;
export const SEO_CAPTURE_MAX_MASKS = 20;
export const SEO_CAPTURE_MAX_MASK_BOXES = 200;

/** The longest selector or text a target names, in characters. */
export const SEO_CAPTURE_MAX_TARGET_CHARS = 300;

/**
 * Why a capture asks for more than one shot may do, or null: at most {@link SEO_CAPTURE_MAX_TARGETS}
 * marks, {@link SEO_CAPTURE_MAX_MASKS} selectors to blur, each selector or text at most
 * {@link SEO_CAPTURE_MAX_TARGET_CHARS} characters.
 *
 * @param request - The focus, the marks and the masks.
 * @returns The refusal, or null.
 */
export function seoCaptureProblem(request: {
	focus: SeoCaptureTarget | null;
	highlights: readonly SeoCaptureTarget[];
	mask: readonly string[];
}): string | null {
	if (request.highlights.length > SEO_CAPTURE_MAX_TARGETS)
		return `A screenshot marks at most ${String(SEO_CAPTURE_MAX_TARGETS)} elements.`;
	if (request.mask.length > SEO_CAPTURE_MAX_MASKS)
		return `A screenshot blurs at most ${String(SEO_CAPTURE_MAX_MASKS)} selectors.`;
	const texts = [request.focus, ...request.highlights].flatMap((target) =>
		target === null ? [] : [target.selector ?? "", target.text ?? ""]
	);
	if ([...texts, ...request.mask].some((text) => text.length > SEO_CAPTURE_MAX_TARGET_CHARS)) {
		return `A selector or a text to find is at most ${String(SEO_CAPTURE_MAX_TARGET_CHARS)} characters.`;
	}
	return null;
}

/**
 * The targets a capture is asked for, cut to sane sizes.
 *
 * @param targets - The targets.
 * @returns At most 9, each selector and text at most 300 characters.
 */
export function seoCaptureTargets(targets: readonly SeoCaptureTarget[]): SeoCaptureTarget[] {
	return targets.slice(0, SEO_CAPTURE_MAX_TARGETS).map((target) => ({
		...(target.selector === undefined ? {} : { selector: target.selector.slice(0, 300) }),
		...(target.text === undefined ? {} : { text: target.text.slice(0, 300) })
	}));
}
