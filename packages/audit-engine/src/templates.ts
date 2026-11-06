import type { DefaultTreeAdapterTypes } from "parse5";

import { sha256 } from "./main-text";

/**
 * PAGE TEMPLATES: pages built from one layout (every blog post, every product page) share a template.
 * A template is the page's URL pattern (`host/blog/*`) plus its LAYOUT SKELETON: the hash of the
 * container elements around the content (header, nav, footer, the wrappers and their ids and classes),
 * never the content itself, so two posts of one layout hash the same however their text differs.
 *
 * The skeleton is read from the stored page (the rendered DOM when the page was rendered) in the
 * markup pass of both runtimes; the template ids are given out at every audit over the whole site.
 * They pick the lab test sample (one page per template) and group issues later. Pure.
 */

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** The HTML namespace. */
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** The elements that make up a layout; every other element is content and is left out. */
const CONTAINERS: ReadonlySet<string> = new Set([
	"header",
	"footer",
	"nav",
	"main",
	"aside",
	"article",
	"section",
	"div",
	"form"
]);

/** The containers that hold the page's own content: kept in the skeleton, never walked into. */
const CONTENT_ROOTS: ReadonlySet<string> = new Set(["main", "article"]);

/** How deep below `<body>` the skeleton reads. */
const MAX_DEPTH = 6;

/** The most elements one skeleton reads, so a huge DOM costs a bounded walk. */
const MAX_ELEMENTS = 2_000;

/** The most class names one element contributes. */
const MAX_CLASSES = 4;

/** Class names that say a state (`is-open`, `has-image`, `active`), not a layout. */
const STATE_CLASS = /^(?:is|has|js)-|^(?:active|current|open|selected|hidden|visible)$/i;

/** A path segment that names a language or a market (`en`, `en-us`, `pt_BR`). */
const LOCALE_SEGMENT = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

/**
 * An attribute of an element.
 *
 * @param element - The element.
 * @param name - The attribute.
 * @returns Its value, or "".
 */
function attribute(element: Element, name: string): string {
	return element.attrs.find((attr) => attr.name === name)?.value ?? "";
}

/**
 * A name with its digits taken out, so `post-123` and `post-456` read the same.
 *
 * @param value - The id or class name.
 * @returns It without digits, lowercased.
 */
function withoutDigits(value: string): string {
	return value.replace(/\d+/g, "").toLowerCase().slice(0, 40);
}

/**
 * One container as the skeleton names it: its tag, its id and its layout classes.
 *
 * @param element - The container.
 * @returns The name.
 */
function containerName(element: Element): string {
	const id = withoutDigits(attribute(element, "id"));
	const classes = [
		...new Set(
			attribute(element, "class")
				.split(/\s+/)
				.filter((name) => name !== "" && !STATE_CLASS.test(name))
				.map(withoutDigits)
				.filter((name) => name.replace(/[-_]/g, "") !== "")
		)
	]
		.sort()
		.slice(0, MAX_CLASSES);
	return `${element.tagName}${id === "" ? "" : `#${id}`}${classes.length === 0 ? "" : `.${classes.join(".")}`}`;
}

/**
 * The containers directly under a node, looking through the elements that are not containers.
 *
 * @param node - The node.
 * @returns Its nearest container descendants.
 */
function childContainers(node: Node): Element[] {
	const found: Element[] = [];
	const stack: Node[] = "childNodes" in node ? [...node.childNodes].reverse() : [];
	let looked = 0;
	while (stack.length > 0 && looked < MAX_ELEMENTS) {
		const child = stack.pop();
		if (child === undefined) break;
		if (!("tagName" in child) || child.namespaceURI !== HTML_NS) continue;
		looked += 1;
		if (CONTAINERS.has(child.tagName)) {
			found.push(child);
			continue;
		}
		if (child.tagName === "script" || child.tagName === "style" || child.tagName === "template")
			continue;
		for (let index = child.childNodes.length - 1; index >= 0; index -= 1) {
			const grandchild = child.childNodes[index];
			if (grandchild !== undefined) stack.push(grandchild);
		}
	}
	return found;
}

/**
 * THE LAYOUT SKELETON of a page: a hash of its containers below `<body>`, each named by its tag, id
 * and layout classes, its children kept as a set (ten cards read as one) and the content containers
 * (`<main>`, `<article>`) never walked into.
 *
 * @param body - The parsed `<body>`, or undefined when the page has none.
 * @returns The skeleton's hash (16 hex characters), or null without a body.
 */
export function layoutSkeleton(body: Element | undefined): string | null {
	if (body === undefined) return null;
	let budget = MAX_ELEMENTS;
	const shape = (node: Node, depth: number): string => {
		if (depth >= MAX_DEPTH || budget <= 0) return "";
		const parts = new Set<string>();
		for (const child of childContainers(node)) {
			budget -= 1;
			if (budget <= 0) break;
			const name = containerName(child);
			parts.add(CONTENT_ROOTS.has(child.tagName) ? name : `${name}${shape(child, depth + 1)}`);
		}
		return parts.size === 0 ? "" : `[${[...parts].sort().join(",")}]`;
	};
	return sha256(`body${shape(body, 0)}`).slice(0, 16);
}

/**
 * A page key's URL pattern: the host, a language segment as `{lang}`, the first folder kept when the
 * page sits in one, every segment below it as `*` (`host/blog/*`, `host/{lang}/docs/*`); a page at the
 * top level is `host/*`, the home page `host/`. The query is left out.
 *
 * @param pageKey - The page's `normalizePageUrl` key (`host/path`).
 * @returns The pattern.
 */
export function urlPattern(pageKey: string): string {
	const withoutQuery = pageKey.split(/[?#]/)[0] ?? pageKey;
	const slash = withoutQuery.indexOf("/");
	const host = slash === -1 ? withoutQuery : withoutQuery.slice(0, slash);
	const segments = (slash === -1 ? "" : withoutQuery.slice(slash + 1))
		.split("/")
		.filter((segment) => segment !== "");
	const pattern: string[] = [];
	let rest = segments;
	if (rest.length > 1 && LOCALE_SEGMENT.test(rest[0] ?? "")) {
		pattern.push("{lang}");
		rest = rest.slice(1);
	}
	rest.forEach((segment, index) => {
		const folder = index === 0 && rest.length > 1 && !/\d/.test(segment);
		pattern.push(folder ? segment.toLowerCase() : "*");
	});
	return `${host}/${pattern.join("/")}`;
}

/**
 * A template's id: the hash of its URL pattern and its layout skeleton.
 *
 * @param pageKey - The page.
 * @param skeleton - Its layout skeleton.
 * @returns The id (16 hex characters).
 */
export function templateIdOf(pageKey: string, skeleton: string): string {
	return sha256(`${urlPattern(pageKey)}\n${skeleton}`).slice(0, 16);
}

/**
 * Every page's template id.
 *
 * @param pages - Each page's key and the layout skeleton its latest read kept (null when none).
 * @returns Page key to its template id, null for a page whose layout was never read.
 */
export function pageTemplates(
	pages: readonly { pageKey: string; skeleton: string | null }[]
): Map<string, string | null> {
	return new Map(
		pages.map((page) => [
			page.pageKey,
			page.skeleton === null ? null : templateIdOf(page.pageKey, page.skeleton)
		])
	);
}
