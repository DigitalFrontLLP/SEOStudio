import { AUDIT_EXAMPLES, finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditOutlink, AuditPage } from "./types";

/**
 * THE RULES OVER THE LINKS ONE PAGE HOLDS: internal links with no anchor text or only a generic one
 * ("click here", "read more"), and links that switch scheme (an https page linking to its site's http
 * URLs). Each page's links are streamed to these rules a batch of pages at a time.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS: anchors are judged per TARGET, not per link, so an image or a
 * "read more" beside a link with descriptive words to the same page is fine; a link to the page itself
 * is left out; an image link's alt text and a link's accessible label count as its anchor.
 */

/**
 * Generic anchors that say nothing about the target, in the languages most sites use: compared after
 * lowercasing and dropping punctuation, arrows and ellipses. Words that may name something on their
 * own ("go", "plus") are left out.
 */
const GENERIC_ANCHORS: ReadonlySet<string> = new Set([
	"click here",
	"here",
	"read more",
	"more",
	"learn more",
	"see more",
	"view more",
	"find out more",
	"more info",
	"more information",
	"details",
	"view details",
	"continue",
	"continue reading",
	"link",
	"this link",
	"this page",
	"hier",
	"hier klicken",
	"mehr",
	"weiterlesen",
	"mehr erfahren",
	"mehr lesen",
	"ici",
	"cliquez ici",
	"en savoir plus",
	"lire la suite",
	"aquí",
	"aqui",
	"haz clic aquí",
	"pulsa aquí",
	"leer más",
	"más",
	"más información",
	"ver más",
	"qui",
	"clicca qui",
	"leggi di più",
	"scopri di più",
	"continua a leggere",
	"altro",
	"clique aqui",
	"leia mais",
	"saiba mais",
	"mais",
	"ver mais",
	"klik hier",
	"lees meer",
	"meer",
	"meer informatie",
	"tutaj",
	"kliknij tutaj",
	"czytaj więcej",
	"więcej"
]);

/** How much an anchor says: nothing, something generic, or words that describe the target. */
type AnchorClass = 0 | 1 | 2;

/**
 * How much an anchor says about its target.
 *
 * @param anchor - The anchor text.
 * @returns 0 for none, 1 for a generic one, 2 for a descriptive one.
 */
function anchorClass(anchor: string): AnchorClass {
	const words = anchor
		.toLowerCase()
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (words === "") return 0;
	return GENERIC_ANCHORS.has(words) ? 1 : 2;
}

/**
 * The scheme a page was served over, from where its fetch landed.
 *
 * @param page - The page.
 * @returns `https:`, `http:`, or null when unknown.
 */
function pageScheme(page: AuditPage): "https:" | "http:" | null {
	const chain = page.facts?.redirectChain ?? [];
	const url = chain[chain.length - 1]?.url ?? page.snapshot?.finalUrl ?? "";
	if (/^https:/i.test(url)) return "https:";
	if (/^http:/i.test(url)) return "http:";
	return null;
}

/**
 * The anchor findings of a page's internal links, judged per target.
 *
 * @param page - The page.
 * @param outlinks - Its links.
 * @param context - The audit.
 * @returns The findings.
 */
function anchorFindings(
	page: AuditPage,
	outlinks: readonly AuditOutlink[],
	context: AuditContext
): AuditFinding[] {
	const self = context.resolve(page.pageKey);
	const best = new Map<string, { kind: AnchorClass; spelled: string; anchor: string }>();
	for (const link of outlinks) {
		if (link.targetKey === null) continue;
		const target = context.resolve(link.targetKey);
		if (target === self) continue;
		const kind = anchorClass(link.anchor);
		const held = best.get(target);
		if (held === undefined || kind > held.kind) {
			best.set(target, { kind, spelled: link.targetKey, anchor: link.anchor.trim() });
		}
	}
	const empty = [...best.values()].filter((entry) => entry.kind === 0);
	const generic = [...best.values()].filter((entry) => entry.kind === 1);
	const found: AuditFinding[] = [];
	if (empty.length > 0) {
		found.push(
			finding(page.pageKey, "anchor_missing", {
				count: empty.length,
				targets: empty.map((entry) => entry.spelled).slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	if (generic.length > 0) {
		found.push(
			finding(page.pageKey, "anchor_non_descriptive", {
				count: generic.length,
				anchor: generic[0]?.anchor ?? "",
				targets: generic.map((entry) => entry.spelled).slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	return found;
}

/**
 * The page's internal links that spell the other scheme: http URLs on an https page, or https URLs on
 * an http one. A stored internal link without a spelling is `https://` plus its key.
 *
 * @param page - The page.
 * @param outlinks - Its links.
 * @returns The finding, or nothing.
 */
function schemeFindings(page: AuditPage, outlinks: readonly AuditOutlink[]): AuditFinding[] {
	const scheme = pageScheme(page);
	if (scheme === null) return [];
	const switched = new Set<string>();
	for (const link of outlinks) {
		if (link.targetKey === null) continue;
		const href = link.href ?? `https://${link.targetKey}`;
		const linkScheme = /^https:/i.test(href) ? "https:" : /^http:/i.test(href) ? "http:" : null;
		if (linkScheme !== null && linkScheme !== scheme) switched.add(href);
	}
	if (switched.size === 0) return [];
	return [
		finding(page.pageKey, "links_to_http", {
			count: switched.size,
			to: scheme === "https:" ? "http" : "https",
			examples: [...switched].sort().slice(0, AUDIT_EXAMPLES)
		})
	];
}

/**
 * The outlink findings of one page.
 *
 * @param page - The page.
 * @param outlinks - The links it holds, internal and outbound.
 * @param context - The audit.
 * @returns Its findings.
 */
export function outlinkFindings(
	page: AuditPage,
	outlinks: readonly AuditOutlink[],
	context: AuditContext
): AuditFinding[] {
	if (htmlSnapshot(page) === null) return [];
	return [...anchorFindings(page, outlinks, context), ...schemeFindings(page, outlinks)];
}
