import { SEO_DOM_LIMITS } from "./dom-facts-schema";

/**
 * THE IN-PAGE PROBE: the scripts a render runs inside a rendered page to measure what only a laid-out
 * page shows - widths, text sizes, tap targets, images, the largest paint, layout shifts, the DOM's
 * size, overlays, links built from other elements, history entries, infinite scroll - and the
 * accessibility checks (axe-core).
 *
 * Every script here runs in an ISOLATED WORLD of the page (`SEO_PROBE_WORLD`): it shares the page's DOM
 * but none of its JavaScript, so a page that redefines `getBoundingClientRect`, `getComputedStyle`,
 * `history` or `axe` changes nothing the probe reads. Every walk is capped by a count, every list by
 * {@link SEO_DOM_LIMITS}, and the render bounds every call by time (`./render-cdp`).
 *
 * Plain strings: no Node, no browser types; the render hands them to the page over DevTools.
 */

/** The isolated world the probe runs in; the page's own scripts cannot reach it. */
export const SEO_PROBE_WORLD = "__seo_probe";

/** Elements a scan looks at before it stops: the probe's work stays bounded on any page. */
const SCAN_ELEMENTS = 20_000;

/** Text nodes the font-size scan reads. */
const SCAN_TEXT_NODES = 30_000;

/** Tap targets measured. */
const SCAN_TARGETS = 2_000;

/**
 * Inline wrappers a small link's sentence test climbs through to the block that holds its line; each
 * block's text is measured once however many links it holds, so the test stays linear on any page.
 */
const SCAN_INLINE_CLIMB = 8;

/** Images measured. */
const SCAN_IMAGES = 600;

/** The smallest tap target, in CSS pixels (WCAG 2.2, 2.5.8). */
export const SEO_TAP_TARGET_PX = 24;

/** The text size under which text is hard to read on a phone, in CSS pixels. */
export const SEO_SMALL_TEXT_PX = 12;

/**
 * Runs in the probe's world as each document starts, before the page's own scripts: the history
 * length the document began with, observers of the largest paint and of layout shifts (buffered, so
 * nothing before the probe is missed), and the images that FADE IN. Such an image loads while it (or
 * a box around it) is at opacity 0 under an opacity transition or animation, and the page then shows
 * it by that transition. Chrome ignores a paint at opacity 0 for the largest paint, and the
 * transition runs without painting the image again, so Chrome never takes the image as the largest
 * paint. The image is read at its `load` on the document's capture phase (an element's `load` never
 * reaches the window), before the page's own `onload` starts the fade.
 */
export const SEO_PROBE_INIT_SCRIPT = `(() => {
	const state = { historyStart: history.length, lcp: null, shifts: { score: 0, count: 0, nodes: [] }, fadedIn: new WeakSet() };
	try { Object.defineProperty(globalThis, "__seoProbeState", { value: state }); } catch {}
	const fades = (el) => {
		for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 8; node = node.parentElement, depth += 1) {
			const style = getComputedStyle(node);
			if (style.opacity !== "0") continue;
			const timed = (list) => list.split(",").some((value) => parseFloat(value) > 0);
			const transition = /(?:^|,\\s*)(?:opacity|all)(?:,|$)/.test(style.transitionProperty) && timed(style.transitionDuration);
			const animation = style.animationName !== "none" && timed(style.animationDuration);
			return transition || animation;
		}
		return false;
	};
	try {
		document.addEventListener("load", (event) => {
			const target = event.target;
			if (target && target.localName === "img" && fades(target)) state.fadedIn.add(target);
		}, true);
	} catch {}
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) state.lcp = entry;
		}).observe({ type: "largest-contentful-paint", buffered: true });
	} catch {}
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (entry.hadRecentInput) continue;
				state.shifts.score += entry.value;
				state.shifts.count += 1;
				for (const source of entry.sources || []) {
					if (state.shifts.nodes.length < 20 && source.node && source.node.nodeType === 1) state.shifts.nodes.push(source.node);
				}
			}
		}).observe({ type: "layout-shift", buffered: true });
	} catch {}
})();`;

/** How the probe runs. */
export interface SeoProbeOptions {
	/** Whether it scrolls to the bottom to see whether more content loads (infinite scroll). */
	scroll: boolean;
	/** The longest one scroll round waits for content, in ms. */
	scrollWaitMs: number;
	/** The probe's whole time, in ms: a scroll round starts only while it fits. */
	budgetMs: number;
}

/**
 * The probe: one expression, evaluated in the probe's world once the page settled, that answers the
 * layout facts as plain JSON (the render adds what it measured itself: the transfer and whether a
 * history entry repeats).
 *
 * @param options - Whether to test for infinite scroll, and how long to wait.
 * @returns The expression (a promise of the facts).
 */
export function seoProbeExpression(options: SeoProbeOptions): string {
	const l = SEO_DOM_LIMITS;
	return `(async () => {
	const SCAN = ${String(SCAN_ELEMENTS)}, TEXT_NODES = ${String(SCAN_TEXT_NODES)}, TARGETS = ${String(SCAN_TARGETS)}, IMAGES = ${String(SCAN_IMAGES)};
	const EXAMPLES = ${String(l.examples)}, SELECTOR = ${String(l.selectorChars)}, URL_CHARS = ${String(l.urlChars)}, IMAGE_LIST = ${String(l.images)};
	const INLINE_CLIMB = ${String(SCAN_INLINE_CLIMB)};
	const TAP = ${String(SEO_TAP_TARGET_PX)}, SMALL_TEXT = ${String(SEO_SMALL_TEXT_PX)};
	const state = globalThis.__seoProbeState || { historyStart: history.length, lcp: null, shifts: { score: 0, count: 0, nodes: [] }, fadedIn: new WeakSet() };
	const begun = performance.now();
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	await sleep(30);
	const root = document.documentElement;
	const body = document.body;
	if (!root || !body) return null;
	const vw = window.innerWidth, vh = window.innerHeight;
	const deviceWidth = root.clientWidth;
	const styles = new Map();
	const styleOf = (el) => {
		let style = styles.get(el);
		if (style === undefined) { style = getComputedStyle(el); styles.set(el, style); }
		return style;
	};
	const shown = (el) => {
		if (typeof el.checkVisibility === "function") {
			if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
		} else {
			const style = styleOf(el);
			if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
		}
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};
	const pathOf = (el) => {
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && parts.length < 4) {
			let part = node.localName;
			if (node.id) { parts.unshift(part + "#" + node.id); break; }
			const names = typeof node.className === "string" ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
			if (names.length > 0) part += "." + names.join(".");
			parts.unshift(part);
			node = node.parentElement;
		}
		const path = parts.join(" > ");
		return path.length > SELECTOR ? path.slice(0, SELECTOR) : path;
	};
	const absolute = (value) => {
		try {
			const href = new URL(value, document.baseURI).href;
			return /^https?:/i.test(href) ? href.slice(0, URL_CHARS) : null;
		} catch { return null; }
	};
	const pageTop = (rect) => rect.top + window.scrollY;

	let elements = 0, depth = 0, width = 0;
	{
		const stack = [[root, 1]];
		while (stack.length > 0 && elements < 200000) {
			const [el, level] = stack.pop();
			elements += 1;
			if (level > depth) depth = level;
			const children = el.children;
			if (children.length > width) width = children.length;
			for (let at = 0; at < children.length && elements + stack.length < 200000; at += 1) stack.push([children[at], level + 1]);
		}
	}

	const clipsX = (el) => { const x = styleOf(el).overflowX; return x === "hidden" || x === "clip"; };
	const contentWidth = clipsX(root) || clipsX(body) ? vw : Math.max(vw, root.scrollWidth);
	const overflowing = [];
	if (contentWidth > deviceWidth + 1) {
		const all = body.getElementsByTagName("*");
		for (let at = 0; at < all.length && at < SCAN && overflowing.length < EXAMPLES; at += 1) {
			const el = all[at];
			const rect = el.getBoundingClientRect();
			if (rect.right <= deviceWidth + 1 || rect.width <= 0 || rect.height <= 0) continue;
			if (styleOf(el).position === "fixed") continue;
			const parent = el.parentElement;
			if (parent && parent !== body && parent.getBoundingClientRect().right > deviceWidth + 1) continue;
			overflowing.push(pathOf(el));
		}
	}

	let chars = 0, smallChars = 0;
	{
		const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
		const verdicts = new Map();
		let seen = 0;
		for (let node = walker.nextNode(); node !== null && seen < TEXT_NODES; node = walker.nextNode()) {
			seen += 1;
			const length = node.data.replace(/\\s+/g, "").length;
			if (length === 0) continue;
			const parent = node.parentElement;
			if (!parent) continue;
			let verdict = verdicts.get(parent);
			if (verdict === undefined) {
				const tag = parent.localName;
				if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || !shown(parent)) verdict = 0;
				else verdict = parseFloat(styleOf(parent).fontSize) < SMALL_TEXT ? 2 : 1;
				verdicts.set(parent, verdict);
			}
			if (verdict === 0) continue;
			chars += length;
			if (verdict === 2) smallChars += length;
		}
	}

	const TARGET = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=switch], [onclick]";
	const targets = [];
	{
		const blockChars = new Map();
		const charsOf = (block) => {
			let chars = blockChars.get(block);
			if (chars === undefined) {
				chars = (block.textContent || "").trim().length;
				blockChars.set(block, chars);
			}
			return chars;
		};
		const found = document.querySelectorAll(TARGET);
		for (let at = 0; at < found.length && targets.length < TARGETS; at += 1) {
			const el = found[at];
			if (el.parentElement && el.parentElement.closest(TARGET)) continue;
			if (!shown(el)) continue;
			const rect = el.getBoundingClientRect();
			const small = rect.width < TAP - 0.5 || rect.height < TAP - 0.5;
			let inline = false;
			if (small && styleOf(el).display === "inline") {
				let block = el.parentElement;
				for (let climbed = 0; climbed < INLINE_CLIMB && block && block !== body && block.localName !== "li" && styleOf(block).display === "inline"; climbed += 1) block = block.parentElement;
				const own = (el.textContent || "").trim().length;
				const around = block ? charsOf(block) : 0;
				inline = around > own + 10;
			}
			targets.push({ el, rect, small: small && !inline, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 });
		}
	}
	const tooClose = (target) => {
		for (const other of targets) {
			if (other === target) continue;
			if (other.small) {
				if (Math.hypot(other.cx - target.cx, other.cy - target.cy) < TAP) return true;
			} else {
				const dx = Math.max(other.rect.left - target.cx, 0, target.cx - other.rect.right);
				const dy = Math.max(other.rect.top - target.cy, 0, target.cy - other.rect.bottom);
				if (Math.hypot(dx, dy) < TAP / 2) return true;
			}
		}
		return false;
	};
	let smallTargets = 0;
	const targetExamples = [];
	for (const target of targets) {
		if (!target.small || !tooClose(target)) continue;
		smallTargets += 1;
		if (targetExamples.length < EXAMPLES) targetExamples.push(pathOf(target.el));
	}

	const LAZY_ATTRIBUTES = ["data-src", "data-srcset", "data-lazy", "data-lazy-src", "data-original"];
	const lazyOf = (img) => {
		if ((img.getAttribute("loading") || "").toLowerCase() === "lazy") return true;
		if (!LAZY_ATTRIBUTES.some((name) => img.hasAttribute(name))) return false;
		const src = img.getAttribute("src") || "";
		return src === "" || src.startsWith("data:") || /lazy|placeholder|blank|spacer/i.test(src);
	};
	const imageUrl = (img) => {
		const source = (img.currentSrc || img.getAttribute("src") || "").trim();
		return source === "" ? null : absolute(source);
	};
	const images = [];
	const offscreen = [];
	let imageCandidate = null;
	const fadedIn = [];
	{
		const all = document.images;
		for (let at = 0; at < all.length && at < IMAGES; at += 1) {
			const img = all[at];
			if (!shown(img)) continue;
			const rect = img.getBoundingClientRect();
			const url = imageUrl(img);
			if (url === null || /\\.svg(?:[?#]|$)/i.test(url)) continue;
			const sizedByMarkup = img.hasAttribute("width") && img.hasAttribute("height");
			const fillsParent = img.parentElement !== null && Math.abs(img.parentElement.getBoundingClientRect().width - rect.width) <= 1;
			const placeholderBox = (!img.hasAttribute("width") && Math.round(rect.width) === 300) || (!sizedByMarkup && !fillsParent && Math.abs(rect.width * 9 - rect.height * 16) <= 16);
			const top = pageTop(rect);
			if (rect.width >= 16 && rect.height >= 16 && !placeholderBox) images.push({ url, width: Math.round(rect.width), height: Math.round(rect.height), top: Math.max(0, Math.round(top)) });
			if (top >= vh * 2 && rect.width * rect.height >= 10000 && !lazyOf(img)) offscreen.push(url);
			const visibleWidth = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
			const visibleHeight = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
			const area = visibleWidth * visibleHeight;
			if (area > 0 && state.fadedIn.has(img)) {
				if (fadedIn.length < EXAMPLES && !fadedIn.includes(url)) fadedIn.push(url);
			} else if (area > 0 && (imageCandidate === null || area > imageCandidate.area)) imageCandidate = { el: img, url, area, kind: "image" };
		}
		for (const video of document.querySelectorAll("video[poster]")) {
			if (!shown(video)) continue;
			const rect = video.getBoundingClientRect();
			const area = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
			if (area > 0 && (imageCandidate === null || area > imageCandidate.area)) imageCandidate = { el: video, url: absolute(video.getAttribute("poster") || ""), area, kind: "video" };
		}
	}
	images.sort((left, right) => right.width * right.height - left.width * left.height);

	let lcp = null;
	{
		const entry = state.lcp;
		const textEntry = entry && !entry.url ? entry : null;
		const textEl = textEntry && textEntry.element ? textEntry.element : null;
		const textArea = textEntry ? textEntry.size : 0;
		if (imageCandidate !== null && imageCandidate.area >= textArea) {
			const el = imageCandidate.el;
			lcp = {
				kind: imageCandidate.kind,
				selector: pathOf(el),
				url: imageCandidate.url,
				lazy: imageCandidate.kind === "image" ? lazyOf(el) : false,
				fetchPriority: (el.getAttribute("fetchpriority") || "").slice(0, 20) || null
			};
		} else if (textEntry !== null) {
			lcp = { kind: "text", selector: textEl ? pathOf(textEl) : "", url: null, lazy: false, fetchPriority: null };
		}
	}

	const shiftSources = [];
	for (const node of state.shifts.nodes) {
		if (shiftSources.length >= EXAMPLES) break;
		if (!node.isConnected) continue;
		const path = pathOf(node);
		if (!shiftSources.includes(path)) shiftSources.push(path);
	}

	let overlay = null;
	{
		const CONSENT = /cookie|consent|gdpr|ccpa|\\bcmp\\b|cmp-|-cmp|privacy|onetrust|didomi|usercentrics|truste|osano|iubenda|cky-|sp_message|age-?gate|age-?verif|agegate/i;
		const fixedAncestor = (el) => {
			let found = null;
			for (let node = el, hops = 0; node && node !== root && node !== body && hops < 40; node = node.parentElement, hops += 1) {
				const position = styleOf(node).position;
				if (position === "fixed") found = node;
			}
			return found;
		};
		const hits = new Map();
		const points = [0.25, 0.5, 0.75];
		for (const fx of points) for (const fy of points) {
			const el = document.elementFromPoint(vw * fx, vh * fy);
			if (!el) continue;
			const fixed = fixedAncestor(el);
			if (fixed) hits.set(fixed, (hits.get(fixed) || 0) + 1);
		}
		let best = null;
		for (const [el, count] of hits) if (best === null || count > best[1]) best = [el, count];
		if (best !== null && best[1] >= 6) {
			const el = best[0];
			const rect = el.getBoundingClientRect();
			const coverage = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0)) / (vw * vh);
			const around = [];
			for (let node = el.parentElement, hops = 0; node && node !== root && node !== body && hops < 10; node = node.parentElement, hops += 1) around.push(node);
			const marks = [el, ...around, ...Array.from(el.querySelectorAll("[id], [class], [aria-label]")).slice(0, 50)]
				.map((node) => (node.id || "") + " " + (typeof node.className === "string" ? node.className : "") + " " + (node.getAttribute("aria-label") || ""))
				.join(" ");
			const inside = (el.innerText || "").replace(/\\s+/g, "").length;
			const all = (body.innerText || "").replace(/\\s+/g, "").length;
			if (coverage >= 0.5 && !CONSENT.test(marks) && all - inside >= 200 && inside < all * 0.5) {
				overlay = { selector: pathOf(el), coverage: Math.round(coverage * 100) / 100 };
			}
		}
	}

	let fakeLinkCount = 0;
	const fakeLinkExamples = [];
	{
		const found = document.querySelectorAll("[role=link], [data-href], [data-url], [data-link]");
		for (let at = 0; at < found.length && at < SCAN; at += 1) {
			const el = found[at];
			const tag = el.localName;
			if (tag === "a" || tag === "area" || tag === "link" || tag === "button") continue;
			if (el.closest("a[href]") || el.querySelector("a[href]")) continue;
			const role = (el.getAttribute("role") || "").toLowerCase() === "link";
			if (role && (el.getAttribute("aria-disabled") === "true" || (el.getAttribute("aria-current") || "false") !== "false")) continue;
			const target = el.getAttribute("data-href") || el.getAttribute("data-url") || el.getAttribute("data-link") || "";
			const urlLike = /^(?:\\/(?!\\/)|https?:\\/\\/)/i.test(target.trim());
			const endpoint = /(?:^|\\/)(?:api|ajax|lazyload|lazy-load|graphql|wp-json)(?:[\\/?#]|$)|\\.json(?:[?#]|$)/i.test(target.trim());
			if (!role && !(urlLike && !endpoint && styleOf(el).cursor === "pointer")) continue;
			if (!shown(el)) continue;
			fakeLinkCount += 1;
			if (fakeLinkExamples.length < EXAMPLES) fakeLinkExamples.push(pathOf(el));
		}
	}

	const pushed = Math.max(0, history.length - state.historyStart);

	let infiniteScroll = null;
	if (${options.scroll ? "true" : "false"} && root.scrollHeight > vh * 1.5) {
		const NEXT = /^(?:page|p|pg|paged|pagina|seite|start|offset)$/i;
		const paginatedLink = () => {
			if (document.querySelector("link[rel~=next][href], a[rel~=next][href]")) return true;
			const anchors = document.querySelectorAll("a[href]");
			for (let at = 0; at < anchors.length && at < 5000; at += 1) {
				let url;
				try { url = new URL(anchors[at].href); } catch { continue; }
				if (url.host !== location.host) continue;
				if (/\\/page\\/[2-9]\\d*\\/?$/i.test(url.pathname)) return true;
				for (const [name, value] of url.searchParams) if (NEXT.test(name) && Number(value) >= 2) return true;
			}
			return false;
		};
		const startUrl = location.href;
		const round = async () => {
			if (performance.now() - begun > ${String(options.budgetMs)} - ${String(options.scrollWaitMs)} - 200) return false;
			const before = { elements: body.getElementsByTagName("*").length, height: root.scrollHeight };
			let last = performance.now(), changed = false;
			const watch = new MutationObserver(() => { last = performance.now(); changed = true; });
			watch.observe(body, { childList: true, subtree: true });
			window.scrollTo(0, root.scrollHeight);
			const scrolled = performance.now();
			await sleep(400);
			while (changed && performance.now() - scrolled < ${String(options.scrollWaitMs)} && performance.now() - last < 300) await sleep(100);
			watch.disconnect();
			return body.getElementsByTagName("*").length - before.elements >= 20 && root.scrollHeight - before.height >= vh * 0.5;
		};
		const first = await round();
		const grew = first && (await round());
		const moved = location.href !== startUrl;
		window.scrollTo(0, 0);
		infiniteScroll = { grew, paginated: moved || paginatedLink() };
	}

	return {
		viewport: { width: Math.round(deviceWidth), height: Math.round(vh) },
		contentWidth: Math.round(contentWidth),
		overflowing,
		text: { chars, smallChars },
		tapTargets: { total: targets.length, small: smallTargets, examples: targetExamples },
		images: images.slice(0, IMAGE_LIST),
		offscreenEager: { count: offscreen.length, examples: offscreen.slice(0, EXAMPLES).map((url) => url.slice(0, SELECTOR)) },
		lcp,
		fadedIn,
		layoutShift: { score: Math.round(state.shifts.score * 1000) / 1000, count: state.shifts.count, sources: shiftSources },
		dom: { elements, depth, width },
		history: { pushed, repeated: false },
		overlay,
		fakeLinks: { count: fakeLinkCount, examples: fakeLinkExamples },
		infiniteScroll,
		transfer: { bytes: 0, requests: 0, images: [], fonts: [] }
	};
})()`;
}

/**
 * The accessibility run: axe-core over the document, only the rules named, violations only, every
 * element named by a short CSS path. Evaluated in the probe's world after axe's own source.
 *
 * @param rules - The axe rule ids to run.
 * @returns The expression (a promise of the violations).
 */
export function seoAxeExpression(rules: readonly string[]): string {
	const l = SEO_DOM_LIMITS;
	return `(async () => {
	if (typeof axe === "undefined" || typeof axe.run !== "function") return null;
	const result = await axe.run(document, {
		runOnly: { type: "rule", values: ${JSON.stringify(rules)} },
		preload: false,
		resultTypes: ["violations"],
		selectors: true,
		ancestry: false,
		xpath: false,
		elementRef: false,
		iframes: false,
		performanceTimer: false
	});
	return result.violations.slice(0, ${String(l.violations)}).map((violation) => ({
		id: String(violation.id).slice(0, 80),
		count: violation.nodes.length,
		examples: violation.nodes.slice(0, ${String(l.violationExamples)}).map((node) => String((node.target || [])[0] || "").slice(0, ${String(l.selectorChars)}))
	}));
})()`;
}
