import { wordsOf } from "./main-text";

/**
 * HOW EASY A PAGE'S TEXT IS TO READ: the Flesch reading ease score, 0 (very hard) to 100 (very easy),
 * with the version of the formula fitted to each language it has one for (English, German, Spanish,
 * French, Italian, Dutch, Portuguese, Russian). Syllables are counted by vowel groups, the usual
 * approximation. A language without a formula answers null. Pure.
 */

/** The words a text needs before its reading ease is scored. */
export const READABILITY_MIN_WORDS = 100;

/** The words of a text that are scored, so a very long page costs a bounded time. */
const MAX_WORDS = 20_000;

/** One language's formula: the score from the words per sentence and the syllables per word. */
type Formula = (wordsPerSentence: number, syllablesPerWord: number) => number;

/** The reading ease formula of each language that has one. */
const FORMULAS: Readonly<Record<string, Formula>> = {
	en: (asl, asw) => 206.835 - 1.015 * asl - 84.6 * asw,
	de: (asl, asw) => 180 - asl - 58.5 * asw,
	es: (asl, asw) => 206.84 - 60 * asw - 1.02 * asl,
	fr: (asl, asw) => 207 - 1.015 * asl - 73.6 * asw,
	it: (asl, asw) => 217 - 1.3 * asl - 60 * asw,
	nl: (asl, asw) => 206.835 - 0.93 * asl - 77 * asw,
	pt: (asl, asw) => 248.835 - 1.015 * asl - 84.6 * asw,
	ru: (asl, asw) => 206.835 - 1.3 * asl - 60.1 * asw
};

/** The vowel groups of a word, per alphabet. */
const LATIN_VOWELS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+/gu;
const CYRILLIC_VOWELS = /[аеёиоуыэюя]+/gu;

/**
 * The syllables of one word, by vowel groups; English and French drop a silent final e.
 *
 * @param word - The word, lowercased.
 * @param language - The language's code.
 * @returns At least 1.
 */
function syllables(word: string, language: string): number {
	if (language === "ru") return Math.max(1, word.match(CYRILLIC_VOWELS)?.length ?? 0);
	let stem = word;
	if (language === "en") {
		stem = stem.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/u, "").replace(/^y/u, "");
		return Math.max(1, stem.match(/[aeiouy]{1,2}/gu)?.length ?? 0);
	}
	if (language === "fr" && stem.length > 3) stem = stem.replace(/e(?:s|nt)?$/u, "");
	return Math.max(1, stem.match(LATIN_VOWELS)?.length ?? 0);
}

/**
 * Whether a language has a reading ease formula.
 *
 * @param language - The language's code (ISO 639-1).
 * @returns Whether it does.
 */
export function hasReadabilityFormula(language: string): boolean {
	return Object.hasOwn(FORMULAS, language);
}

/**
 * The reading ease score of a text in a language.
 *
 * @param text - The main text, one block per line (a line ends a sentence, as a heading or a list item does).
 * @param language - Its language's code (ISO 639-1).
 * @returns The score, one decimal, or null when the language has no formula or the text is too short.
 */
export function readingEase(text: string, language: string): number | null {
	const formula = hasReadabilityFormula(language) ? FORMULAS[language] : undefined;
	if (formula === undefined) return null;
	let words = 0;
	let sentences = 0;
	let syllableCount = 0;
	for (const sentence of text.split(/(?<![.!?…])[.!?…]+(?=\s|$)|\n+/u)) {
		if (words >= MAX_WORDS) break;
		const found = wordsOf(sentence.toLowerCase()).filter((word) => /\p{L}/u.test(word));
		if (found.length === 0) continue;
		sentences += 1;
		words += found.length;
		for (const word of found) syllableCount += syllables(word, language);
	}
	if (words < READABILITY_MIN_WORDS || sentences === 0) return null;
	return Math.round(formula(words / sentences, syllableCount / words) * 10) / 10;
}
