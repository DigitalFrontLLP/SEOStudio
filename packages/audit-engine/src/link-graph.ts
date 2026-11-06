/**
 * THE INTERNAL LINK GRAPH IN BOUNDED MEMORY: every link of a site held as numbers, never as one object
 * per link, so a site of 100,000 pages and ten million links fits in a few hundred megabytes. Each key
 * (a page, a link's spelled target, the page that target lands on) is stored once and named by its
 * index; a link is its source, its spelled target, its nofollow flag and, only when the link spelled
 * the URL differently from its key, the spelling. Where a target lands after the known redirects and
 * variants is resolved once per key. The links out of a page and into a page are indexed on first use.
 *
 * The rules read it as plain {@link GraphLink} objects made on demand (iterating, or one page's links),
 * and the graph walks (click depth, Link Score) read the numbers directly. Pure.
 */

/** One internal link as the graph hands it out. */
export interface GraphLink {
	sourceKey: string;
	/** The key the link spells. */
	targetKey: string;
	/** The page that key lands on after known redirects and variants. */
	resolvedKey: string;
	nofollow: boolean;
	/** The URL exactly as the link spelled it, when that differs from `https://` plus its key; else null. */
	href: string | null;
}

/** One link as a graph is built from it. */
export interface GraphLinkInput {
	sourceKey: string;
	targetKey: string;
	/** Where the target lands, when the caller knows better than the resolver. */
	resolvedKey?: string;
	nofollow?: boolean;
	href?: string | null;
}

/** The first capacity of a builder whose size is not known. */
const INITIAL_CAPACITY = 1024;

/**
 * A finished internal link graph: read-only, iterable as {@link GraphLink} objects made on demand.
 */
export class LinkGraph implements Iterable<GraphLink> {
	private fromIndex: { start: Int32Array; links: Int32Array } | null = null;
	private toIndex: { start: Int32Array; links: Int32Array } | null = null;
	private inCounts: Int32Array | null = null;
	private spelledIds: Uint8Array | null = null;

	/**
	 * @param keys - Every key by index.
	 * @param ids - Every key's index.
	 * @param landingOf - The index of the page each key lands on.
	 * @param sources - Each link's source key index.
	 * @param targets - Each link's spelled target key index.
	 * @param flags - Each link's flags (1: nofollow).
	 * @param hrefs - The spelling of the links that spelled their target differently, by link index.
	 * @param resolvedOverrides - The landing given by the caller for a link, by link index.
	 */
	constructor(
		readonly keys: readonly string[],
		private readonly ids: ReadonlyMap<string, number>,
		private readonly landingOf: Int32Array,
		private readonly sources: Int32Array,
		private readonly targets: Int32Array,
		private readonly flags: Uint8Array,
		private readonly hrefs: ReadonlyMap<number, string>,
		private readonly resolvedOverrides: ReadonlyMap<number, number>
	) {}

	/** How many links the graph holds. */
	get length(): number {
		return this.sources.length;
	}

	/** How many keys the graph names. */
	get keyCount(): number {
		return this.keys.length;
	}

	/**
	 * The index of a key, or undefined when the graph never names it.
	 *
	 * @param key - The key.
	 * @returns Its index.
	 */
	idOf(key: string): number | undefined {
		return this.ids.get(key);
	}

	/**
	 * One link's source key index.
	 *
	 * @param link - The link's index.
	 * @returns The source's key index.
	 */
	sourceOf(link: number): number {
		return this.sources[link] ?? 0;
	}

	/**
	 * One link's spelled target key index.
	 *
	 * @param link - The link's index.
	 * @returns The target's key index.
	 */
	targetOf(link: number): number {
		return this.targets[link] ?? 0;
	}

	/**
	 * The key index a link's target lands on.
	 *
	 * @param link - The link's index.
	 * @returns The landing's key index.
	 */
	resolvedOf(link: number): number {
		return this.resolvedOverrides.get(link) ?? this.landingOf[this.targets[link] ?? 0] ?? 0;
	}

	/**
	 * The key index a key index lands on.
	 *
	 * @param id - The key index.
	 * @returns The landing's key index.
	 */
	landing(id: number): number {
		return this.landingOf[id] ?? id;
	}

	/**
	 * Whether a link carries `rel="nofollow"`.
	 *
	 * @param link - The link's index.
	 * @returns Whether it does.
	 */
	nofollow(link: number): boolean {
		return (this.flags[link] ?? 0) === 1;
	}

	/**
	 * One link as an object.
	 *
	 * @param link - The link's index.
	 * @returns The link.
	 */
	link(link: number): GraphLink {
		return {
			sourceKey: this.keys[this.sources[link] ?? 0] ?? "",
			targetKey: this.keys[this.targets[link] ?? 0] ?? "",
			resolvedKey: this.keys[this.resolvedOf(link)] ?? "",
			nofollow: this.nofollow(link),
			href: this.hrefs.get(link) ?? null
		};
	}

	/**
	 * Every link, each made into an object as it is reached.
	 *
	 * @yields The links.
	 */
	*[Symbol.iterator](): Iterator<GraphLink> {
		for (let index = 0; index < this.sources.length; index += 1) yield this.link(index);
	}

	/**
	 * The indices of the links out of each source key index, built once.
	 *
	 * @returns The index.
	 */
	private outgoing(): { start: Int32Array; links: Int32Array } {
		this.fromIndex ??= groupLinks(this.keys.length, this.sources.length, (link) =>
			this.sourceOf(link)
		);
		return this.fromIndex;
	}

	/**
	 * The indices of the links landing on each key index, built once.
	 *
	 * @returns The index.
	 */
	private incoming(): { start: Int32Array; links: Int32Array } {
		this.toIndex ??= groupLinks(this.keys.length, this.sources.length, (link) =>
			this.resolvedOf(link)
		);
		return this.toIndex;
	}

	/**
	 * The indices of the links a key holds (as their source).
	 *
	 * @param id - The source's key index.
	 * @returns The link indices.
	 */
	linksOutOf(id: number): Int32Array {
		const { start, links } = this.outgoing();
		return links.subarray(start[id] ?? 0, start[id + 1] ?? 0);
	}

	/**
	 * The indices of the links that land on a key.
	 *
	 * @param id - The landing's key index.
	 * @returns The link indices.
	 */
	linksInto(id: number): Int32Array {
		const { start, links } = this.incoming();
		return links.subarray(start[id] ?? 0, start[id + 1] ?? 0);
	}

	/**
	 * The links a page holds, as objects.
	 *
	 * @param key - The source's key.
	 * @returns The links, or undefined when it holds none.
	 */
	from(key: string): GraphLink[] | undefined {
		const id = this.ids.get(key);
		if (id === undefined) return undefined;
		const indices = this.linksOutOf(id);
		return indices.length === 0 ? undefined : Array.from(indices, (link) => this.link(link));
	}

	/**
	 * The links that land on a page, as objects.
	 *
	 * @param key - The landing's key.
	 * @returns The links, or undefined when none does.
	 */
	to(key: string): GraphLink[] | undefined {
		const id = this.ids.get(key);
		if (id === undefined) return undefined;
		const indices = this.linksInto(id);
		return indices.length === 0 ? undefined : Array.from(indices, (link) => this.link(link));
	}

	/**
	 * How many links land on a page from another page (a link from the page itself, after landing, is
	 * not counted).
	 *
	 * @param key - The landing's key.
	 * @returns The count.
	 */
	linksIn(key: string): number {
		const id = this.ids.get(key);
		if (id === undefined) return 0;
		if (this.inCounts === null) {
			const counts = new Int32Array(this.keys.length);
			for (let link = 0; link < this.sources.length; link += 1) {
				const landing = this.resolvedOf(link);
				if (this.landing(this.sourceOf(link)) === landing) continue;
				counts[landing] = (counts[landing] ?? 0) + 1;
			}
			this.inCounts = counts;
		}
		return this.inCounts[id] ?? 0;
	}

	/**
	 * How many OTHER pages link to each key as the links spell it (a page linking to itself is not
	 * counted, nor a page linking twice), by key index.
	 *
	 * @returns The counts.
	 */
	linkingPages(): Int32Array {
		const keys = this.keys.length;
		const { start, links } = groupLinks(keys, this.sources.length, (link) => this.targetOf(link));
		const counts = new Int32Array(keys);
		const seen = new Int32Array(keys).fill(-1);
		for (let target = 0; target < keys; target += 1) {
			let count = 0;
			for (let at = start[target] ?? 0; at < (start[target + 1] ?? 0); at += 1) {
				const source = this.sourceOf(links[at] ?? 0);
				if (source === target || seen[source] === target) continue;
				seen[source] = target;
				count += 1;
			}
			counts[target] = count;
		}
		return counts;
	}

	/**
	 * Whether any link spells a key as its target.
	 *
	 * @param key - The key.
	 * @returns Whether one does.
	 */
	spells(key: string): boolean {
		const id = this.ids.get(key);
		if (id === undefined) return false;
		if (this.spelledIds === null) {
			const spelled = new Uint8Array(this.keys.length);
			for (const target of this.targets) spelled[target] = 1;
			this.spelledIds = spelled;
		}
		return (this.spelledIds[id] ?? 0) === 1;
	}
}

/**
 * A graph under construction: links are added one at a time (as a store streams them) into growing
 * typed arrays.
 */
export class LinkGraphBuilder {
	private readonly keys: string[] = [];
	private readonly ids = new Map<string, number>();
	private sources: Int32Array;
	private targets: Int32Array;
	private flags: Uint8Array;
	private readonly hrefs = new Map<number, string>();
	private readonly resolvedOverrides = new Map<number, number>();
	private count = 0;

	/**
	 * @param capacity - How many links are expected (the arrays grow past it when more come).
	 */
	constructor(capacity = INITIAL_CAPACITY) {
		const size = Math.max(1, capacity);
		this.sources = new Int32Array(size);
		this.targets = new Int32Array(size);
		this.flags = new Uint8Array(size);
	}

	/**
	 * The index of a key, given one on first sight.
	 *
	 * @param key - The key.
	 * @returns Its index.
	 */
	idOf(key: string): number {
		let id = this.ids.get(key);
		if (id === undefined) {
			id = this.keys.length;
			this.keys.push(key);
			this.ids.set(key, id);
		}
		return id;
	}

	/**
	 * Adds one link.
	 *
	 * @param link - The link.
	 */
	add(link: GraphLinkInput): void {
		if (this.count === this.sources.length) this.grow();
		const index = this.count;
		this.sources[index] = this.idOf(link.sourceKey);
		const target = this.idOf(link.targetKey);
		this.targets[index] = target;
		this.flags[index] = link.nofollow === true ? 1 : 0;
		if (link.href != null) this.hrefs.set(index, link.href);
		if (link.resolvedKey !== undefined && link.resolvedKey !== link.targetKey) {
			this.resolvedOverrides.set(index, this.idOf(link.resolvedKey));
		}
		this.count += 1;
	}

	/** Doubles the arrays. */
	private grow(): void {
		const size = this.sources.length * 2;
		const sources = new Int32Array(size);
		sources.set(this.sources);
		const targets = new Int32Array(size);
		targets.set(this.targets);
		const flags = new Uint8Array(size);
		flags.set(this.flags);
		this.sources = sources;
		this.targets = targets;
		this.flags = flags;
	}

	/**
	 * The finished graph.
	 *
	 * @param resolve - The page a key lands on after the known redirects and variants.
	 * @returns The graph.
	 */
	build(resolve: (key: string) => string = (key) => key): LinkGraph {
		const known = this.keys.length;
		const resolved = new Int32Array(known);
		for (let id = 0; id < known; id += 1) {
			const landing = resolve(this.keys[id] ?? "");
			resolved[id] = this.idOf(landing);
		}
		const extra = this.keys.length;
		const landings = new Int32Array(extra);
		landings.set(resolved);
		for (let id = known; id < extra; id += 1) landings[id] = id;
		return new LinkGraph(
			this.keys,
			this.ids,
			landings,
			this.sources.slice(0, this.count),
			this.targets.slice(0, this.count),
			this.flags.slice(0, this.count),
			this.hrefs,
			this.resolvedOverrides
		);
	}
}

/**
 * A graph built from a list of links.
 *
 * @param links - The links.
 * @param resolve - The page a key lands on after the known redirects and variants.
 * @returns The graph.
 */
export function linkGraphOf(
	links: Iterable<GraphLinkInput>,
	resolve: (key: string) => string = (key) => key
): LinkGraph {
	const builder = new LinkGraphBuilder(
		Array.isArray(links) ? Math.max(1, links.length) : INITIAL_CAPACITY
	);
	for (const link of links) builder.add(link);
	return builder.build(resolve);
}

/**
 * Link indices grouped by a key index (counting sort): `links[start[k]..start[k+1]]` are key k's.
 *
 * @param keys - How many key indices.
 * @param count - How many links.
 * @param keyOf - The key index of a link.
 * @returns The grouped indices.
 */
function groupLinks(
	keys: number,
	count: number,
	keyOf: (link: number) => number
): { start: Int32Array; links: Int32Array } {
	const start = new Int32Array(keys + 1);
	for (let link = 0; link < count; link += 1) {
		const key = keyOf(link);
		start[key + 1] = (start[key + 1] ?? 0) + 1;
	}
	for (let key = 0; key < keys; key += 1)
		start[key + 1] = (start[key + 1] ?? 0) + (start[key] ?? 0);
	const fill = start.slice(0, keys);
	const links = new Int32Array(count);
	for (let link = 0; link < count; link += 1) {
		const key = keyOf(link);
		const at = fill[key] ?? 0;
		links[at] = link;
		fill[key] = at + 1;
	}
	return { start, links };
}
