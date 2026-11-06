import type { SeoPageGrammarFacts, SeoPageGrammarIssue } from "./facts";

import { SEO_GRAMMAR_LIMITS } from "./reading-limits";

/**
 * THE GRAMMAR CHECK OF A PAGE, on a member's computer only: the host lends a checker (the desktop app's
 * Harper, an English grammar checker compiled to WebAssembly that runs on the computer, no server and no
 * Java), and this file decides what it reads and what is kept. Only English pages are read (a page
 * whose language says English, or says none), the title, the H1 and the main text, bounded; only the
 * problem's kind, its text and the first suggestion are kept, never an English message.
 *
 * PRECISION FIRST: only the kinds that name a mistake in a sentence are kept ({@link GRAMMAR_KINDS}),
 * and never one that spans two lines (two table cells or list items read as one sentence).
 * The checker's other kinds misfire on web text, where headings, menus, list items, table cells and code
 * are joined into one text: a heading or a list item reads as a sentence without a capital or a full
 * stop, every straight quote as unbalanced, a table as one 150-word sentence, and style advice ("config"
 * to "configuration", an Oxford comma) is not a mistake. Spelling is left to the spelling check, which
 * judges a word against the site's own vocabulary. Pure apart from the checker.
 */

/** One problem the checker found. */
export interface SeoGrammarLint {
	/** The kind of problem, as the checker names it (`Grammar`, `Repetition`, ...). */
	kind: string;
	/** The text it is about. */
	text: string;
	/** The first replacement it suggests, or null. */
	suggestion: string | null;
}

/** Checks a text's grammar; the host's checker (Harper on the desktop app). Rejects when it cannot. */
export type SeoGrammarChecker = (text: string) => Promise<SeoGrammarLint[]>;

export { SEO_GRAMMAR_LIMITS };

/**
 * The checker's kinds kept (lower case): mistakes in a sentence (a wrong word form, a repeated word, a
 * word confused with another, a split or joined word, words out of order). Every other kind is
 * dropped: capitalization, formatting, punctuation, readability, style, word choice, regionalism,
 * redundancy, spelling and typos, and the miscellaneous article checks, which call "an MIT licence"
 * and "an _ character" wrong.
 */
const GRAMMAR_KINDS: ReadonlySet<string> = new Set([
	"grammar",
	"repetition",
	"eggcorn",
	"malapropism",
	"boundaryerror",
	"wordorder"
]);

/**
 * A value cut to its bound, its white space folded.
 *
 * @param value - The value.
 * @returns The value kept.
 */
function kept(value: string): string {
	const folded = value.replace(/\s+/gu, " ").trim();
	return folded.length > SEO_GRAMMAR_LIMITS.textKept
		? folded.slice(0, SEO_GRAMMAR_LIMITS.textKept)
		: folded;
}

/**
 * A token that is code, not prose: a code character (`{ } < > = ; $ \` | \\ ~ ^`), a command line flag
 * (`--force`), an identifier joined by `_`, a dotted or colon-joined name (`v.$color`, `site.title`,
 * `npm:hugo`), or a camelCase word. LINEAR: every alternative is a fixed run of single characters (no
 * quantifier on a group, no unbounded repeat), so a test costs one pass over the text whatever it holds.
 */
const CODE_TOKEN =
	/[{}<>=;$`|\\~^]|(?:^|\s)-[-a-z]|\w_\w|[a-z]\.[a-z][a-z]|[a-z]:[a-z]|[a-z][A-Z][a-z]/u;

/** The most characters of one line (or one problem's text) the code and word tests read. */
const MAX_LINE_CHARS = 2_000;

/**
 * The fewest words a line must hold to be read: a menu item, a button or a table cell is not a
 * sentence.
 */
const MIN_LINE_WORDS = 4;

/**
 * Whether a line of the page's text is prose the check reads: enough words and no code in it, so code
 * samples (blocks and inline) and interface labels are never judged as English sentences.
 *
 * @param line - The line.
 * @returns Whether it is read.
 */
function grammarReadsLine(line: string): boolean {
	const head = line.slice(0, MAX_LINE_CHARS);
	if (CODE_TOKEN.test(head)) return false;
	return (head.match(/\p{L}+/gu) ?? []).length >= MIN_LINE_WORDS;
}

/**
 * The words a real repeated-word mistake repeats ("the the", "to to"): a repeated name or command
 * ("hugo hugo") is nearly always code or a list, never a typing slip worth a reader's time.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set(
	(
		"a an the and or but nor so yet if of to in on at by for from with as into onto about over " +
		"under than that this these those it its is are was were be been am has have had do does did " +
		"will would can could should shall may might must not no we you he she they i me us them my " +
		"your our their his her which who what when where how there here then"
	).split(" ")
);

/**
 * Whether a repetition repeats a function word.
 *
 * @param text - The repeated text the checker marked.
 * @returns Whether it does.
 */
function repeatsFunctionWord(text: string): boolean {
	const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
	return words.length > 0 && words.every((word) => FUNCTION_WORDS.has(word));
}

/** The inline code elements whose words are code, not English. */
const CODE_TAGS = ["code", "kbd", "samp", "var"] as const;

/** The most characters of a page's HTML the code word scan reads. */
const MAX_CODE_HTML_CHARS = 2_000_000;

/** The most characters inside one element for it to count as inline code at all. */
const MAX_INLINE_CODE_CHARS = 200;

/**
 * The most words an element may hold to count as code set inline in a sentence (`<code>and</code>`);
 * a longer one is a code block, whose lines the line filter already leaves out, and whose comments
 * would otherwise hide real mistakes made with the same everyday words.
 */
const INLINE_CODE_WORDS = 3;

/** The most code words collected from one page. */
const MAX_CODE_WORDS = 2_000;

/**
 * The words a page sets inline as code (`<code>`, `<kbd>`, `<samp>`, `<var>` of a few words), lower
 * case: a grammar problem that names one is about code in a sentence ("see and and or"), so it is
 * never filed. A plain forward scan (no regular expression over the page): each search starts where
 * the last one ended, and a tag with no closing tag left ends its scan, so the work is linear in the
 * HTML read, which is capped.
 *
 * @param html - The page's HTML (the rendered one when there is one).
 * @returns The words.
 */
export function grammarCodeWords(html: string): Set<string> {
	const source = html.slice(0, MAX_CODE_HTML_CHARS).toLowerCase();
	const words = new Set<string>();
	for (const tag of CODE_TAGS) {
		let at = 0;
		for (;;) {
			const open = source.indexOf(`<${tag}`, at);
			if (open < 0) break;
			const next = source[open + tag.length + 1] ?? "";
			const end = source.indexOf(">", open);
			if (end < 0) break;
			if (next !== ">" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
				at = end + 1;
				continue;
			}
			const close = source.indexOf(`</${tag}`, end);
			if (close < 0) break;
			at = close + tag.length + 2;
			if (close - end - 1 > MAX_INLINE_CODE_CHARS) continue;
			const inner = source.slice(end + 1, close).replace(/<[^>]*>/gu, " ");
			const found = inner.match(/\p{L}+/gu) ?? [];
			if (found.length > INLINE_CODE_WORDS) continue;
			for (const word of found) {
				words.add(word);
				if (words.size >= MAX_CODE_WORDS) return words;
			}
		}
	}
	return words;
}

/**
 * Whether a page reads as English to the check: its language says English, or says nothing.
 *
 * @param lang - The page's declared language, or null.
 * @returns Whether it is read.
 */
export function grammarReadsLanguage(lang: string | null): boolean {
	const code = (lang ?? "").trim().toLowerCase();
	return code === "" || code === "en" || code.startsWith("en-") || code.startsWith("en_");
}

/**
 * The grammar facts of one page: the checker run over its title, H1 and main text.
 *
 * @param page - The page's title, H1, main text and declared language.
 * @param checker - The host's checker.
 * @param codeWords - The words of the page's code samples ({@link grammarCodeWords}): a problem
 *   naming one is about code written inline in a sentence ("see and and or"), never English.
 * @returns The facts, or null when the page is not English, holds no text, or the checker failed.
 */
export async function grammarFactsOf(
	page: { title: string; h1: string; mainText: string; lang: string | null },
	checker: SeoGrammarChecker,
	codeWords: ReadonlySet<string> = new Set()
): Promise<SeoPageGrammarFacts | null> {
	if (!grammarReadsLanguage(page.lang)) return null;
	const text = [page.title, page.h1, page.mainText]
		.flatMap((part) => part.slice(0, SEO_GRAMMAR_LIMITS.textChars).split("\n"))
		.map((line) => line.trim())
		.filter(grammarReadsLine)
		.join("\n\n")
		.slice(0, SEO_GRAMMAR_LIMITS.textChars);
	if (text === "") return null;
	let lints: SeoGrammarLint[];
	try {
		lints = await checker(text);
	} catch {
		return null;
	}
	const issues: SeoPageGrammarIssue[] = [];
	let count = 0;
	for (const lint of lints) {
		const kind = lint.kind.toLowerCase();
		if (!GRAMMAR_KINDS.has(kind)) continue;
		const head = lint.text.slice(0, MAX_LINE_CHARS);
		if (/[\r\n]/u.test(head) || CODE_TOKEN.test(head)) continue;
		if (kind === "repetition" && !repeatsFunctionWord(head)) continue;
		if ((head.toLowerCase().match(/\p{L}+/gu) ?? []).some((word) => codeWords.has(word))) continue;
		const problem = kept(lint.text);
		if (problem === "") continue;
		count += 1;
		if (issues.length < SEO_GRAMMAR_LIMITS.issues) {
			const suggestion = lint.suggestion === null ? null : kept(lint.suggestion);
			issues.push({ kind: kept(lint.kind), text: problem, suggestion });
		}
	}
	return { checked: text.length, count, issues };
}
