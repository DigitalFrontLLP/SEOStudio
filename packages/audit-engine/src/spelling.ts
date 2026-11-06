import type { SeoPageSpellingFacts } from "./facts";
import nspell from "nspell";

import { detectLanguages, primaryLanguage } from "./language";
import { decompressText } from "./main-text";

/**
 * THE SPELLING CHECK: the words of a page's main text, title and H1 that its language's Hunspell
 * dictionary does not know. Run while a page is read: on the server only for pages with search traffic
 * and only in the languages whose dictionary is light to hold, on a member's computer for every page
 * and every language here.
 *
 * PRECISION FIRST (a typo report full of names is worse than none): a word is judged only when the
 * text reads as a supported language (one of the languages it reads as must be the one the page
 * declares, when it declares one; else it must read as that language alone);
 * a word with a capital letter (a name, a brand, an acronym), a digit, a symbol or a script other than
 * the dictionary's is never judged in the main text; addresses, e-mails, handles and file names are
 * dropped before the words are read; a title or H1 word is judged in any case but only when the main
 * text never uses it. The site-wide rule then drops the words several pages share (the site's own
 * terms). English accepts both its American and British spelling.
 */

/** A dictionary's id, as generated under `./dictionaries`. */
type DictionaryId = "en-us" | "en-gb" | "es" | "fr" | "nl";

/** Each language the check reads, with its dictionaries and whether the server may hold them. */
const LANGUAGES: Readonly<Record<string, { dictionaries: DictionaryId[]; server: boolean }>> = {
	en: { dictionaries: ["en-us", "en-gb"], server: true },
	es: { dictionaries: ["es"], server: true },
	nl: { dictionaries: ["nl"], server: true },
	fr: { dictionaries: ["fr"], server: false }
};

/** Which languages a reading checks: those light enough for the server, or every one (a member's computer). */
export type SeoSpellingScope = "server" | "all";

/** The fewest main text words judged before a page's spelling is reported. */
const MIN_CHECKED = 50;

/** The most distinct unknown words of the main text kept, and of the title and H1 each. */
const TEXT_WORDS = 20;
const HEADING_WORDS = 10;

/** The fewest letters of a word judged. */
const MIN_LETTERS = 3;

/** The fewest letters of one part of a hyphenated word judged (`add-ons` never files `ons`). */
const HYPHEN_PART_LETTERS = 4;

/** The most characters of a word judged (a longer one is a code or a run-on, not a typo). */
const MAX_LETTERS = 30;

/**
 * How much of a page the check reads, whatever the page holds: the main text's characters, a title's
 * or H1's characters, the characters of one token (a longer run without white space is a code or an
 * address, never a word), and the words judged.
 */
export const SEO_SPELLING_LIMITS = {
	textChars: 200_000,
	headingChars: 1_000,
	tokenChars: 100,
	words: 20_000
} as const;

/**
 * A token that holds an address, an e-mail, a handle, a hashtag or a file name: never read for words.
 * Linear on any token: literal starts, single characters and one bounded repeat, nothing nested.
 */
const NOT_WORD = /https?:\/\/|www\.|[@#]|[\p{L}\p{N}_-]\.[a-z]{2,4}(?![\p{L}\p{N}_])/iu;

/** A run of letters, with the apostrophes and hyphens inside a word (read only within a short token). */
const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;

/** A token that holds a digit, an underscore or a character a word never holds: not judged at all. */
const CODE_LIKE = /[\p{N}_=<>{}[\]\\/|~^*+$%&]/u;

/** Latin letters only (every dictionary here is in the Latin script). */
const LATIN = /^[\p{Script=Latin}\p{M}'’-]+$/u;

/** The loaded dictionaries, each built once per process. */
const loaded = new Map<DictionaryId, Promise<ReturnType<typeof nspell>>>();

/**
 * The generated module of a dictionary, imported on first use.
 *
 * @param id - The dictionary.
 * @returns Its encoded files.
 */
async function dictionaryModule(id: DictionaryId): Promise<{ aff: string; dic: string }> {
	switch (id) {
		case "en-us":
			return (await import("./dictionaries/en-us.generated")).dictionary;
		case "en-gb":
			return (await import("./dictionaries/en-gb.generated")).dictionary;
		case "es":
			return (await import("./dictionaries/es.generated")).dictionary;
		case "fr":
			return (await import("./dictionaries/fr.generated")).dictionary;
		case "nl":
			return (await import("./dictionaries/nl.generated")).dictionary;
	}
}

/**
 * A dictionary, built on first use and kept.
 *
 * @param id - The dictionary.
 * @returns The speller.
 */
function speller(id: DictionaryId): Promise<ReturnType<typeof nspell>> {
	let pending = loaded.get(id);
	if (pending === undefined) {
		pending = dictionaryModule(id).then(async (files) =>
			nspell(await decompressText(files.aff), await decompressText(files.dic))
		);
		pending.catch(() => loaded.delete(id));
		loaded.set(id, pending);
	}
	return pending;
}

/**
 * The language a page's spelling is read in: the language its text reads as, when a dictionary covers
 * it and the language the page declares (if any) agrees.
 *
 * @param mainText - The main text.
 * @param declared - The declared language (`<html lang>`), or null.
 * @param scope - Which languages may be read.
 * @returns The language, or null when the page is not judged.
 */
export function spellingLanguage(
	mainText: string,
	declared: string | null,
	scope: SeoSpellingScope
): string | null {
	const detected = detectLanguages(mainText.slice(0, SEO_SPELLING_LIMITS.textChars));
	if (detected === null) return null;
	const own = primaryLanguage(declared ?? "");
	const language =
		own === ""
			? detected.length === 1
				? detected[0]
				: undefined
			: detected.find((candidate) => primaryLanguage(candidate) === own);
	if (language === undefined) return null;
	const entry = LANGUAGES[language];
	if (entry === undefined || (scope === "server" && !entry.server)) return null;
	return language;
}

/**
 * The words of a text, the non-words dropped: split on white space, a token too long to be a word or
 * holding an address, a handle, a file name, a digit or a symbol skipped, at most `limit` words.
 *
 * @param text - The text.
 * @param limit - The most words returned.
 * @returns The words, in order.
 */
function words(text: string, limit: number): string[] {
	const found: string[] = [];
	for (const token of text.split(/\s+/u)) {
		if (
			token === "" ||
			token.length > SEO_SPELLING_LIMITS.tokenChars ||
			NOT_WORD.test(token) ||
			CODE_LIKE.test(token)
		)
			continue;
		for (const match of token.matchAll(WORD)) {
			const parts = match[0].replaceAll("’", "'").split("-");
			const least = parts.length > 1 ? HYPHEN_PART_LETTERS : MIN_LETTERS;
			for (const part of parts) {
				if (part.length < least || part.length > MAX_LETTERS) continue;
				found.push(part);
				if (found.length >= limit) return found;
			}
		}
	}
	return found;
}

/**
 * English derivations a small dictionary leaves out, each as the ending and what replaces it to give
 * the base word (`customizations` from `customize`, `personalization` from `personalize`). Only
 * derivational endings: a misspelt plural or past tense (`tomatos`) is never read as known.
 */
const ENGLISH_DERIVATIONS: readonly (readonly [string, string])[] = [
	["izations", "ize"],
	["ization", "ize"],
	["isations", "ise"],
	["isation", "ise"],
	["ations", "ate"],
	["ation", "ate"],
	["abilities", "able"],
	["ability", "able"],
	["ness", ""],
	["less", ""]
];

/** The fewest letters of the first and of the second word of a closed compound (`web` + `hook`). */
const COMPOUND_HEAD = 3;
const COMPOUND_TAIL = 4;

/**
 * Whether any of the language's dictionaries knows a word, as written or in its lower or capitalized
 * form.
 *
 * @param spellers - The language's dictionaries.
 * @param word - The word.
 * @param anyCase - Whether its lower and capitalized forms count too (a title's words).
 * @returns Whether it is known.
 */
function knownForm(
	spellers: readonly ReturnType<typeof nspell>[],
	word: string,
	anyCase: boolean
): boolean {
	const forms = anyCase
		? [word, word.toLowerCase(), word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()]
		: [word];
	return spellers.some((spell) => forms.some((form) => spell.correct(form)));
}

/**
 * Whether a word is known: as written, as a derivation of a known English word the dictionary leaves
 * out, or as a closed compound of two known words (`timeframe`, `chargebacks`, `webhook`), which a
 * dictionary cannot list but a reader never takes for a typo.
 *
 * @param spellers - The language's dictionaries.
 * @param word - The word.
 * @param anyCase - Whether its lower and capitalized forms count too (a title's words).
 * @param language - The page's language.
 * @returns Whether it is known.
 */
function known(
	spellers: readonly ReturnType<typeof nspell>[],
	word: string,
	anyCase: boolean,
	language: string
): boolean {
	if (knownForm(spellers, word, anyCase)) return true;
	const lower = word.toLowerCase();
	if (language === "en") {
		for (const [ending, base] of ENGLISH_DERIVATIONS) {
			const stem = lower.slice(0, -ending.length);
			if (
				lower.endsWith(ending) &&
				stem.length >= COMPOUND_TAIL &&
				(knownForm(spellers, `${stem}${base}`, false) ||
					(base !== "" && knownForm(spellers, stem, false)))
			)
				return true;
		}
	}
	for (let split = COMPOUND_HEAD; split <= lower.length - COMPOUND_TAIL; split += 1) {
		if (
			knownForm(spellers, lower.slice(0, split), false) &&
			knownForm(spellers, lower.slice(split), false)
		)
			return true;
	}
	return false;
}

/**
 * The unknown words of a title or H1: any case, the part after the last separator (the site's name)
 * and the words the main text uses left out. The H1 is part of the main text, so a word counts as the
 * text's own only when the text uses it more often than the H1 does (else a typo in the H1, and in a
 * title that repeats it, would vouch for itself).
 *
 * @param spellers - The language's dictionaries.
 * @param heading - The title or H1.
 * @param pageWords - How often the main text uses each word, lowercased.
 * @param h1Words - How often the H1 uses each word, lowercased.
 * @param stripSiteName - Whether the part after the last separator is left out (a title).
 * @param language - The page's language.
 * @returns The unknown words, lowercased.
 */
function headingUnknown(
	spellers: readonly ReturnType<typeof nspell>[],
	heading: string,
	pageWords: ReadonlyMap<string, number>,
	h1Words: ReadonlyMap<string, number>,
	stripSiteName: boolean,
	language: string
): string[] {
	const read = heading.slice(0, SEO_SPELLING_LIMITS.headingChars);
	const parts = read.split(/\s[|–—·:-]\s/u);
	const kept = stripSiteName && parts.length > 1 ? parts.slice(0, -1).join(" ") : read;
	const found = new Set<string>();
	for (const word of words(kept, SEO_SPELLING_LIMITS.words)) {
		if (!LATIN.test(word)) continue;
		const inner = word.slice(1);
		if (inner !== inner.toLowerCase()) continue;
		const lower = word.toLowerCase();
		const used = (pageWords.get(lower) ?? 0) > (h1Words.get(lower) ?? 0);
		if (used || known(spellers, word, true, language)) continue;
		found.add(lower);
		if (found.size >= HEADING_WORDS) break;
	}
	return [...found];
}

/**
 * A page's spelling facts.
 *
 * @param input - The page's main text, title, H1 and declared language.
 * @param scope - Which languages may be read (the server's light ones, or all on a member's computer).
 * @returns The facts, or null when the page is not judged (an unsupported language, too few words).
 */
export async function spellingFactsOf(
	input: { mainText: string; title: string; h1: string; lang: string | null },
	scope: SeoSpellingScope
): Promise<SeoPageSpellingFacts | null> {
	const text = input.mainText.slice(0, SEO_SPELLING_LIMITS.textChars);
	const language = spellingLanguage(text, input.lang, scope);
	if (language === null) return null;
	const entry = LANGUAGES[language];
	if (entry === undefined) return null;
	const spellers = await Promise.all(entry.dictionaries.map(speller));
	const pageWords = new Map<string, number>();
	const unknown = new Map<string, number>();
	const verdicts = new Map<string, boolean>();
	let checked = 0;
	for (const word of words(text, SEO_SPELLING_LIMITS.words)) {
		pageWords.set(word.toLowerCase(), (pageWords.get(word.toLowerCase()) ?? 0) + 1);
		if (word !== word.toLowerCase() || !LATIN.test(word)) continue;
		checked += 1;
		let isKnown = verdicts.get(word);
		if (isKnown === undefined) {
			isKnown = known(spellers, word, false, language);
			verdicts.set(word, isKnown);
		}
		if (!isKnown) unknown.set(word, (unknown.get(word) ?? 0) + 1);
	}
	if (checked < MIN_CHECKED) return null;
	const h1Words = new Map<string, number>();
	for (const word of words(
		input.h1.slice(0, SEO_SPELLING_LIMITS.headingChars),
		SEO_SPELLING_LIMITS.words
	)) {
		const lower = word.toLowerCase();
		h1Words.set(lower, (h1Words.get(lower) ?? 0) + 1);
	}
	return {
		language,
		checked,
		text: [...unknown]
			.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
			.slice(0, TEXT_WORDS)
			.map(([word, count]) => ({ word, count })),
		title: headingUnknown(spellers, input.title, pageWords, h1Words, true, language),
		h1: headingUnknown(spellers, input.h1, pageWords, h1Words, false, language)
	};
}
