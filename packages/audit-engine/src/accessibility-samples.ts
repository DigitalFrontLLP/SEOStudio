import { hostOfKey } from "./scope";

/**
 * WHICH PAGES THE SERVER RUNS ITS ACCESSIBILITY CHECKS ON, besides pages with search traffic: one page
 * per kind of URL, so a template's problems are found once without checking every page built from it
 * (the checks cost CPU on the shared runner; the desktop app checks every page). Pure.
 *
 * A kind of URL is its first folder and its number of folders (`/blog/a-post` and `/blog/b-post` are
 * one kind; every page one folder deep is one kind; the home page is its own). A page three or more
 * folders deep adds its second folder, since sites that put a language or a version first build each
 * section below it from its own template (`/en/docs/a` and `/en/blog/b` are two kinds). A folder of
 * digits or an id counts as `:id`, so dated archives stay one kind. The page chosen for a
 * kind is the first of it in the plan's order (the home page first, then pages with traffic, then by
 * clicks from the home page), so the choice is stable from one plan to the next.
 */

/** The most pages one plan picks. */
export const SEO_A11Y_SAMPLES_MAX = 100;

/**
 * The kind of URL a page key is.
 *
 * @param pageKey - A normalized page key (`host/path`).
 * @returns The kind, e.g. `blog/2`.
 */
export function urlKindOf(pageKey: string): string {
	const host = hostOfKey(pageKey);
	const path = pageKey.slice(host.length).split(/[?#]/)[0] ?? "";
	const folders = path.split("/").filter((part) => part !== "");
	if (folders.length === 0) return "/";
	if (folders.length === 1) return "*/1";
	const named = folderKind(folders[0] ?? "");
	if (folders.length < 3) return `${named}/${String(folders.length)}`;
	return `${named}/${folderKind(folders[1] ?? "")}/${String(folders.length)}`;
}

/**
 * What one folder of a URL says about its kind: the folder itself, or `:id` for digits or an id.
 *
 * @param folder - The folder.
 * @returns Its kind.
 */
function folderKind(folder: string): string {
	const lower = folder.toLowerCase();
	return /^\d+$/.test(lower) || /^[0-9a-f-]{16,}$/i.test(lower) ? ":id" : lower;
}

/**
 * The first page of each kind of URL, in the order given.
 *
 * @param pageKeys - The plan's pages, most important first.
 * @returns The chosen page keys, at most {@link SEO_A11Y_SAMPLES_MAX}.
 */
export function accessibilitySamples(pageKeys: readonly string[]): string[] {
	const kinds = new Set<string>();
	const chosen: string[] = [];
	for (const key of pageKeys) {
		if (chosen.length >= SEO_A11Y_SAMPLES_MAX) break;
		const kind = urlKindOf(key);
		if (kinds.has(kind)) continue;
		kinds.add(kind);
		chosen.push(key);
	}
	return chosen;
}
