import type { SeoPageTextFacts } from "./facts";

import { detectLanguages, primaryLanguage, sameLanguage } from "./language";
import { countWords } from "./main-text";
import { encodeSignature, minhashSignature } from "./minhash";
import { readingEase } from "./readability";

/**
 * WHAT THE CONTENT RULES KEEP FROM A PAGE'S MAIN TEXT (`audit_facts.text`): its near-duplicate
 * fingerprint, the languages it reads as, its reading ease and whether it is only a shop's "no
 * products" notice, never the text. Worked out where the reading is committed, so a page read on the
 * server and one read on a member's computer get the same facts. Pure.
 */

/**
 * THE EMPTY LISTING NOTICES shop platforms show where a category or a product list has nothing in it,
 * by their default wording, calibrated on live pages (2026-10-08): PrestaShop in English, French and
 * German, WooCommerce in English, German and Spanish, BigCommerce, and Shopify's two theme generations.
 * Only whole default sentences: a shorter "no results" names too many other pages.
 */
const EMPTY_LISTING_PHRASES: readonly string[] = [
	"no products available yet",
	"aucun produit disponible pour le moment",
	"noch keine produkte verfügbar",
	"no products were found matching your selection",
	"es wurden keine produkte gefunden, die deiner auswahl entsprechen",
	"no se han encontrado productos que concuerden con la selección",
	"no se han encontrado productos que concuerden con su selección",
	"there are no products listed under this category",
	"sorry, there are no products in this collection",
	"no products found"
];

/** The lines a platform shows beside its notice, which are no content of the page either. */
const EMPTY_LISTING_COMPANIONS: readonly string[] = [
	"stay tuned! more products will be shown here as they are added.",
	"bleiben sie dran! sobald weitere produkte hinzugefügt wurden, werden sie hier angezeigt.",
	"use fewer filters or remove all"
];

/**
 * The most words a main text may hold beside the notice and its companion lines and still be only
 * the notice: a heading, a breadcrumb, a sort menu and a pager, never a page's own text.
 */
export const EMPTY_LISTING_MAX_OTHER_WORDS = 40;

/**
 * Whether a main text is only a shop platform's empty listing notice ("No products available yet"):
 * it holds one of {@link EMPTY_LISTING_PHRASES}, and at most {@link EMPTY_LISTING_MAX_OTHER_WORDS}
 * words beside it and the lines that go with it.
 *
 * @param mainText - The page's main text.
 * @returns Whether it is.
 */
export function isEmptyListingText(mainText: string): boolean {
	let text = mainText.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");
	if (!EMPTY_LISTING_PHRASES.some((phrase) => text.includes(phrase))) return false;
	for (const phrase of [...EMPTY_LISTING_PHRASES, ...EMPTY_LISTING_COMPANIONS])
		text = text.split(phrase).join(" ");
	return countWords(text) <= EMPTY_LISTING_MAX_OTHER_WORDS;
}

/**
 * The language a text's reading ease is scored in: the one the page declares when the text reads as
 * it (or cannot be told), else the one the text reads as.
 *
 * @param declared - The page's declared language code, or "".
 * @param languages - The languages the text reads as, or null when it cannot be told.
 * @returns The language's code, or "" when there is none.
 */
function readingLanguage(declared: string, languages: readonly string[] | null): string {
	if (declared !== "" && (languages === null || languages.some((l) => sameLanguage(l, declared))))
		return declared;
	return languages?.[0] ?? "";
}

/**
 * The text facts of one page.
 *
 * @param mainText - The page's main text.
 * @param declaredLang - The language the page declares (`<html lang>`), or null.
 * @returns The facts to store.
 */
export function textFactsOf(mainText: string, declaredLang: string | null): SeoPageTextFacts {
	const signature = minhashSignature(mainText);
	const languages = detectLanguages(mainText);
	const language = readingLanguage(primaryLanguage(declaredLang ?? ""), languages);
	const score = language === "" ? null : readingEase(mainText, language);
	return {
		minhash: signature === null ? null : encodeSignature(signature),
		languages,
		readability: score === null ? null : { language, score },
		...(isEmptyListingText(mainText) ? { emptyListing: true } : {})
	};
}
