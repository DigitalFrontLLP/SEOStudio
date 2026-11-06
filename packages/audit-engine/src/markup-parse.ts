import { defaultTreeAdapter, parse, Parser } from "parse5";
import type { DefaultTreeAdapterMap, DefaultTreeAdapterTypes, TreeAdapter } from "parse5";

import { cutDeepMarkup } from "./markup-depth";

/**
 * PARSING HTML FROM OUTSIDE OUR CONTROL WITHIN BOUNDS. Every parse5 tree built from markup someone else
 * wrote (a crawled page, a page the content writer scores, a WordPress post's stored content
 * or new HTML sent for it) is parsed within a work budget ({@link parseWithinBudget}), from markup first
 * cut where its nesting or parse5's copies of formatting elements pass their bounds (`./markup-depth`
 * `cutDeepMarkup`; {@link parseFetchedHtml} does both for a page, {@link parseFragmentWithinBounds} for
 * a fragment). Real markup comes through whole and builds the tree parse5 builds; crafted markup is read
 * up to where a bound stopped it, and flagged (`cut`). Pure.
 */

/**
 * The most work one parse of a page may do: elements made, plus the siblings stepped over to place a
 * node among them (foster parenting, the adoption agency). Real pages of megabytes do under ten
 * thousand; past it the page is read up to where the parser had got to, and flagged (`parseCut`).
 */
export const MARKUP_PARSE_BUDGET = 300_000;

/** A parse ran out of its {@link MARKUP_PARSE_BUDGET}. */
class ParseBudgetSpent extends Error {
	constructor() {
		super("The markup parse ran out of its work budget");
		this.name = "ParseBudgetSpent";
	}
}

/** One parse of a page within a work budget. */
export interface BoundedParse {
	document: DefaultTreeAdapterTypes.Document;
	/** Whether the budget ran out, so the document holds only the page's start. */
	cut: boolean;
	/** The work the parse that answered did. */
	work: number;
}

/**
 * Runs one parse with parse5, counting its work through the tree adapter. The adapter is parse5's own,
 * except that a node is found among its siblings from the END (`lastIndexOf`): the
 * parser inserts before and detaches nodes near the end of their parent, and the default's `indexOf`
 * from the start makes a crafted table that fosters every node out of it cost the square of its size.
 * The tree is the same, since a node is among its parent's children once.
 *
 * @param run - The parse, given the adapter to build with (and source locations on).
 * @param budget - The work allowed.
 * @param locations - Whether the tree keeps its source locations (they are read for the cut either way).
 * @returns The parse's result and its work, or, when the budget ran out, the furthest source offset the
 * parse placed a node from.
 */
function parseCounted<T>(
	run: (adapter: TreeAdapter<DefaultTreeAdapterMap>) => T,
	budget: number,
	locations: boolean
): { result: T; work: number } | { spent: true; reached: number } {
	let work = 0;
	let reached = 0;
	const spend = (amount: number): void => {
		work += amount;
		if (work > budget) throw new ParseBudgetSpent();
	};
	const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
		...defaultTreeAdapter,
		createElement(tagName, namespaceURI, attrs) {
			spend(1);
			return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
		},
		insertBefore(parentNode, newNode, referenceNode) {
			const siblings = parentNode.childNodes;
			const index = siblings.lastIndexOf(referenceNode);
			spend(siblings.length - index);
			siblings.splice(index, 0, newNode);
			newNode.parentNode = parentNode;
		},
		insertTextBefore(parentNode, text, referenceNode) {
			const siblings = parentNode.childNodes;
			const index = siblings.lastIndexOf(referenceNode);
			spend(siblings.length - index);
			const previous = siblings[index - 1];
			if (previous !== undefined && defaultTreeAdapter.isTextNode(previous)) {
				previous.value += text;
				return;
			}
			const node = defaultTreeAdapter.createTextNode(text);
			siblings.splice(index, 0, node);
			node.parentNode = parentNode;
		},
		detachNode(node) {
			const parent = node.parentNode;
			if (parent === null) return;
			const siblings = parent.childNodes;
			const index = siblings.lastIndexOf(node);
			spend(siblings.length - index);
			siblings.splice(index, 1);
			node.parentNode = null;
		},
		setNodeSourceCodeLocation(node, location) {
			if (location !== null) reached = Math.max(reached, location.startOffset);
			if (locations) defaultTreeAdapter.setNodeSourceCodeLocation(node, location);
		},
		updateNodeSourceCodeLocation(node, location) {
			if (locations) defaultTreeAdapter.updateNodeSourceCodeLocation(node, location);
		}
	};
	try {
		const result = run(adapter);
		return { result, work };
	} catch (error) {
		if (error instanceof ParseBudgetSpent) return { spent: true, reached };
		throw error;
	}
}

/**
 * Runs a parse within a work budget. Past it, the markup is parsed again up to the furthest point the
 * first parse placed a node from: everything before that point cost the first parse less than the
 * budget, so the second fits in it.
 *
 * @param html - The markup.
 * @param run - The parse of some markup, given the adapter to build with.
 * @param empty - The result when nothing could be read.
 * @param budget - The work allowed.
 * @param locations - Whether the tree keeps its source locations.
 * @returns The result, whether it holds only the markup's start, and its work.
 */
function boundedRun<T>(
	html: string,
	run: (source: string, adapter: TreeAdapter<DefaultTreeAdapterMap>) => T,
	empty: () => T,
	budget: number,
	locations: boolean
): { result: T; cut: boolean; work: number } {
	let source = html;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const text = source;
		const parsed = parseCounted((adapter) => run(text, adapter), budget, locations);
		if ("result" in parsed) {
			return { result: parsed.result, cut: source.length < html.length, work: parsed.work };
		}
		source = source.slice(0, Math.min(parsed.reached, source.length - 1));
	}
	return { result: empty(), cut: true, work: 0 };
}

/**
 * Parses a page within a work budget ({@link boundedRun}): past it, the page is read up to where the
 * parser had got to.
 *
 * @param html - The page.
 * @param rendered - Whether it is a rendered DOM (scripting on).
 * @param budget - The work allowed.
 * @returns The document and whether it holds only the page's start.
 */
export function parseWithinBudget(
	html: string,
	rendered: boolean,
	budget: number = MARKUP_PARSE_BUDGET
): BoundedParse {
	const parsed = boundedRun(
		html,
		(source, treeAdapter) =>
			parse<DefaultTreeAdapterMap>(source, {
				scriptingEnabled: rendered,
				sourceCodeLocationInfo: true,
				treeAdapter
			}),
		() => parse(""),
		budget,
		true
	);
	return { document: parsed.result, cut: parsed.cut, work: parsed.work };
}

/** A fetched page parsed within bounds. */
export interface FetchedHtmlParse {
	document: DefaultTreeAdapterTypes.Document;
	/** Whether a bound (nesting, copies or work) stopped the read, so the document holds only the page's start. */
	cut: boolean;
}

/**
 * PARSES A FETCHED PAGE WITHIN BOUNDS: cut where its nesting or parse5's copies pass their bounds, then
 * parsed within the work budget. A real page gives the tree `parse5.parse` gives it.
 *
 * @param html - The page.
 * @param rendered - Whether it is a rendered DOM (scripting on, which `parse5.parse` defaults to).
 * @returns The document and whether a bound cut it short.
 */
export function parseFetchedHtml(html: string, rendered: boolean): FetchedHtmlParse {
	const kept = cutDeepMarkup(html);
	const parsed = parseWithinBudget(kept, rendered);
	return { document: parsed.document, cut: parsed.cut || kept.length < html.length };
}

/** A fragment parsed within bounds. */
export interface BoundedFragmentParse {
	/** The fragment's top-level nodes. */
	nodes: DefaultTreeAdapterTypes.ChildNode[];
	/** Whether a bound (nesting, copies or work) stopped the read, so the nodes hold only the fragment's start. */
	cut: boolean;
}

/**
 * Parses a fragment as `parse5.parseFragment` does, but hands its nodes over to the fragment at once:
 * parse5's own hand-over detaches them one by one from the front of the list, which costs the square of
 * the count (a post of tens of thousands of top-level paragraphs took seconds).
 *
 * @param context - The element the fragment sits in.
 * @param source - The fragment.
 * @param treeAdapter - The adapter to build with.
 * @returns The fragment's top-level nodes, each with the fragment as its parent.
 */
function fragmentNodes(
	context: DefaultTreeAdapterTypes.Element,
	source: string,
	treeAdapter: TreeAdapter<DefaultTreeAdapterMap>
): DefaultTreeAdapterTypes.ChildNode[] {
	const parser = Parser.getFragmentParser<DefaultTreeAdapterMap>(context, {
		sourceCodeLocationInfo: true,
		treeAdapter
	});
	parser.tokenizer.write(source, true);
	const root = treeAdapter.getFirstChild(parser.document);
	const fragment = treeAdapter.createDocumentFragment();
	if (root === null || !treeAdapter.isElementNode(root)) return fragment.childNodes;
	fragment.childNodes = root.childNodes;
	root.childNodes = [];
	for (const node of fragment.childNodes) node.parentNode = fragment;
	return fragment.childNodes;
}

/**
 * PARSES A FRAGMENT WITHIN BOUNDS, the way a browser parses it inside a context element: cut where its
 * nesting or parse5's copies pass their bounds, then parsed within the work budget. Real markup gives
 * the nodes `parse5.parseFragment` gives it (scripting on, its default).
 *
 * @param context - The element the fragment sits in.
 * @param html - The fragment.
 * @param locations - Whether the nodes keep their source locations.
 * @returns The fragment's top-level nodes and whether a bound cut it short.
 */
export function parseFragmentWithinBounds(
	context: DefaultTreeAdapterTypes.Element,
	html: string,
	locations: boolean
): BoundedFragmentParse {
	const kept = cutDeepMarkup(html);
	const parsed = boundedRun(
		kept,
		(source, treeAdapter) => fragmentNodes(context, source, treeAdapter),
		() => [],
		MARKUP_PARSE_BUDGET,
		locations
	);
	return { nodes: parsed.result, cut: parsed.cut || kept.length < html.length };
}
