import { francAll } from "franc";

/**
 * WHICH LANGUAGES A PAGE'S TEXT READS AS: a small trigram detector (`franc`, 187 languages) asked for
 * every language that scores close to the best, so a near-tie (Danish and Norwegian, Spanish and
 * Portuguese, English and French) keeps every candidate and a language is ruled out only when the text
 * clearly is not in it. Mixed scripts, short texts and texts that fit too many languages answer null
 * (cannot tell). Pure.
 */

/** The characters of a text the detector reads (it reads no more itself). */
const SAMPLE_CHARS = 2048;

/** The letters a sample needs before its language is judged. */
const MIN_LETTERS = 300;

/** The share of a sample's letters one script must hold, so a mixed-script text is not judged. */
const MIN_SCRIPT_SHARE = 0.8;

/**
 * How far below the best a language may score and stay a candidate, as a share of the gap between the
 * best and the median language of the script: a share does not move with the text's length the way the
 * detector's raw scores do. Measured: the language a text is in scores 0, a close relative 0.1 to 0.35
 * (English and French, Spanish and Portuguese, German and Dutch), an unrelated major language 0.5 or
 * more.
 */
const PLAUSIBLE_GAP = 0.4;

/** The most candidates a text may keep; a text that fits more cannot be told. */
const MAX_CANDIDATES = 8;

/** ISO 639-3 codes of the detector's languages that have an ISO 639-1 code, the macrolanguages folded. */
const ISO_639_1: Readonly<Record<string, string>> = {
	afr: "af",
	als: "sq",
	amh: "am",
	arb: "ar",
	ayr: "ay",
	azj: "az",
	bam: "bm",
	bel: "be",
	ben: "bn",
	bod: "bo",
	bos: "bs",
	bul: "bg",
	cat: "ca",
	ces: "cs",
	ckb: "ku",
	cmn: "zh",
	dan: "da",
	deu: "de",
	ekk: "et",
	ell: "el",
	eng: "en",
	epo: "eo",
	ewe: "ee",
	fin: "fi",
	fra: "fr",
	fuf: "ff",
	fuv: "ff",
	glg: "gl",
	guj: "gu",
	hat: "ht",
	hau: "ha",
	heb: "he",
	hin: "hi",
	hrv: "hr",
	hun: "hu",
	hye: "hy",
	ibo: "ig",
	iii: "ii",
	ind: "id",
	ita: "it",
	jav: "jv",
	jpn: "ja",
	kan: "kn",
	kat: "ka",
	kaz: "kk",
	khk: "mn",
	khm: "km",
	kin: "rw",
	kir: "ky",
	kng: "kg",
	knc: "kr",
	koi: "kv",
	kor: "ko",
	lao: "lo",
	lin: "ln",
	lit: "lt",
	lug: "lg",
	lvs: "lv",
	mal: "ml",
	mar: "mr",
	mkd: "mk",
	mya: "my",
	ndo: "ng",
	nld: "nl",
	nno: "nn",
	nob: "nb",
	npi: "ne",
	nya: "ny",
	pan: "pa",
	pbu: "ps",
	pes: "fa",
	plt: "mg",
	pol: "pl",
	por: "pt",
	prs: "fa",
	quy: "qu",
	quz: "qu",
	qug: "qu",
	ron: "ro",
	run: "rn",
	rus: "ru",
	sag: "sg",
	sin: "si",
	slk: "sk",
	slv: "sl",
	sna: "sn",
	som: "so",
	sot: "st",
	spa: "es",
	src: "sc",
	srp: "sr",
	ssw: "ss",
	sun: "su",
	swe: "sv",
	swh: "sw",
	tam: "ta",
	tat: "tt",
	tel: "te",
	tgk: "tg",
	tgl: "tl",
	tha: "th",
	tir: "ti",
	tsn: "tn",
	tso: "ts",
	tuk: "tk",
	tur: "tr",
	uig: "ug",
	ukr: "uk",
	urd: "ur",
	uzn: "uz",
	ven: "ve",
	vie: "vi",
	wol: "wo",
	xho: "xh",
	ydd: "yi",
	yor: "yo",
	zlm: "ms",
	zul: "zu",
	zyb: "za"
};

/** Codes retired or spelled another way, as pages still write them. */
const ALIASES: Readonly<Record<string, string>> = {
	iw: "he",
	in: "id",
	ji: "yi",
	jw: "jv",
	mo: "ro",
	fil: "tl",
	no: "nb"
};

/**
 * Languages close enough that a detector cannot tell them apart reliably, or that one site may label
 * either way: a page labelled with one is never called mismatched for reading as another.
 */
const SAME_LANGUAGE: readonly (readonly string[])[] = [
	["nb", "nn", "da"],
	["sr", "hr", "bs", "sh", "cnr"],
	["ms", "id"],
	["zh", "ja"],
	["pt", "gl"],
	["es", "gl", "ca", "ast", "an"],
	["en", "sco"],
	["nl", "af"],
	["de", "nds", "lb"],
	["fa", "prs", "tg"],
	["bg", "mk"],
	["ru", "be", "uk"],
	["cs", "sk"],
	["hi", "mr", "ne", "mai", "bho", "mag"],
	["ur", "skr"],
	["qu", "ay"],
	["sw", "rw", "rn"]
];

/** The groups each language belongs to, by its code. */
const GROUPS_OF: ReadonlyMap<string, readonly number[]> = SAME_LANGUAGE.reduce(
	(groups, group, index) => {
		for (const code of group) groups.set(code, [...(groups.get(code) ?? []), index]);
		return groups;
	},
	new Map<string, number[]>()
);

/** The script groups a sample's letters are counted under (CJK scripts count as one). */
const SCRIPTS: readonly RegExp[] = [
	/\p{Script=Latin}/u,
	/\p{Script=Cyrillic}/u,
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u,
	/\p{Script=Arabic}/u,
	/\p{Script=Greek}/u,
	/\p{Script=Hebrew}/u,
	/\p{Script=Devanagari}/u,
	/\p{Script=Thai}/u
];

/**
 * A record's own value for a key, never one inherited from `Object.prototype`.
 *
 * @param record - The record.
 * @param key - The key.
 * @returns The value, or undefined.
 */
function own(record: Readonly<Record<string, string>>, key: string): string | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * A language code as the audit compares it: the primary subtag, lowercased, a three-letter code with
 * a two-letter one folded to it, a retired code to its current one.
 *
 * @param code - A language tag (`en-GB`, `pt_BR`, `eng`) or a detector code.
 * @returns The code, or "" when there is none.
 */
export function primaryLanguage(code: string): string {
	const primary = (code.trim().toLowerCase().split(/[-_]/u)[0] ?? "").trim();
	return own(ALIASES, primary) ?? own(ISO_639_1, primary) ?? primary;
}

/**
 * Whether two language codes name the same language, or two a reader or a detector cannot tell apart.
 *
 * @param left - One code.
 * @param right - The other.
 * @returns Whether they do.
 */
export function sameLanguage(left: string, right: string): boolean {
	const a = primaryLanguage(left);
	const b = primaryLanguage(right);
	if (a === "" || b === "") return false;
	if (a === b) return true;
	const groups = GROUPS_OF.get(b) ?? [];
	return (GROUPS_OF.get(a) ?? []).some((group) => groups.includes(group));
}

/**
 * Whether one script holds nearly all of a sample's letters.
 *
 * @param sample - The text.
 * @returns Whether it does, or null when the sample holds too few letters to judge.
 */
function singleScript(sample: string): boolean | null {
	const letters = sample.match(/\p{L}/gu) ?? [];
	if (letters.length < MIN_LETTERS) return null;
	const counts = SCRIPTS.map(() => 0);
	for (const letter of letters) {
		const index = SCRIPTS.findIndex((script) => script.test(letter));
		if (index >= 0) counts[index] = (counts[index] ?? 0) + 1;
	}
	return Math.max(...counts) / letters.length >= MIN_SCRIPT_SHARE;
}

/**
 * The languages a main text plausibly reads as, the likeliest first.
 *
 * @param text - The main text.
 * @returns ISO 639-1 codes (639-3 for a language without one), or null when the text is too short,
 *   mixes scripts or fits too many languages to tell.
 */
export function detectLanguages(text: string): string[] | null {
	const sample = text.replace(/\s+/gu, " ").trim().slice(0, SAMPLE_CHARS);
	if (singleScript(sample) !== true) return null;
	const scored = francAll(sample, { minLength: 1 });
	if (scored.length === 0 || scored[0]?.[0] === "und") return null;
	const scores = scored.map(([, score]) => score).sort((left, right) => left - right);
	const spread = 1 - (scores[Math.floor(scores.length / 2)] ?? 1);
	const candidates =
		spread <= 0
			? scored.slice(0, 1)
			: scored.filter(([, score]) => (1 - score) / spread <= PLAUSIBLE_GAP);
	if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) return null;
	return [...new Set(candidates.map(([code]) => own(ISO_639_1, code) ?? code))];
}
