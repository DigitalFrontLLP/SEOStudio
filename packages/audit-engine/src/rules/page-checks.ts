import { finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";

/**
 * THE RULES OVER THE OPTIONAL CHECKS OF A PAGE: the AMP validator's errors on an AMP page
 * (`amp_invalid`), what the project's own search and extraction patterns found (`custom_search`),
 * what its custom JavaScript snippets answered (`custom_script`), what its AI prompts answered
 * (`ai_prompt`), and the grammar problems of its English text (`grammar_errors`).
 *
 * - `custom_script`, `ai_prompt` and `grammar_errors` are insights: facts to look through, never counted
 *   as issues. A snippet that failed on the page is listed too, so a broken snippet shows. Grammar and
 *   snippets are read only on a member's computer; a page read elsewhere says nothing about them.
 *
 * - `amp_invalid` is filed only on a 2xx page that declares itself AMP and that the validator judged
 *   with at least one error (its warnings are not problems);
 * - `custom_search` is an insight: a pattern looking for pages that contain something files the pages
 *   that do, one looking for pages without it files the pages that lack it, and an extraction files the
 *   pages it extracted values from. A pattern added after a page was read says nothing about that page
 *   until its next read.
 */

/** The most error codes an AMP finding names. */
const AMP_CODES = 5;

/** The most grammar problems a finding names. */
const GRAMMAR_SHOWN = 10;

/**
 * The AMP validation finding of one page.
 *
 * @param page - The page.
 * @returns The finding, or none.
 */
function ampFindings(page: AuditPage): AuditFinding[] {
	const amp = page.facts?.checks?.amp;
	if (amp == null || amp.errorCount === 0) return [];
	if (page.facts?.markup?.amp.isAmp !== true || htmlSnapshot(page) === null) return [];
	return [
		finding(page.pageKey, "amp_invalid", {
			count: amp.errorCount,
			codes: [...new Set(amp.errors.map((error) => error.code))].slice(0, AMP_CODES),
			messages: amp.errors
				.slice(0, AMP_CODES)
				.map((error) => [error.code, ...error.params].join(" ").slice(0, 200))
		})
	];
}

/**
 * The custom search finding of one page.
 *
 * @param page - The page.
 * @param context - The audit, for the project's patterns.
 * @returns The finding, or none.
 */
function customFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const results = page.facts?.checks?.custom;
	const checks = context.site.customChecks ?? [];
	if (results === undefined || checks.length === 0 || htmlSnapshot(page) === null) return [];
	const byId = new Map(results.map((result) => [result.id, result]));
	const matches = checks.flatMap((check) => {
		const result = byId.get(check.id);
		if (result === undefined) return [];
		const hit =
			check.mode === "contains"
				? result.count > 0
				: check.mode === "absent"
					? result.count === 0
					: result.values.length > 0;
		return hit
			? [{ name: check.name, mode: check.mode, count: result.count, values: result.values }]
			: [];
	});
	return matches.length === 0
		? []
		: [finding(page.pageKey, "custom_search", { count: matches.length, matches })];
}

/**
 * The custom JavaScript snippets' finding of one page: each snippet that answered a value, or failed.
 *
 * @param page - The page.
 * @param context - The audit, for the project's snippets.
 * @returns The finding, or none.
 */
function scriptFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const results = page.facts?.checks?.scripts;
	const scripts = context.site.customScripts ?? [];
	if (results === undefined || scripts.length === 0 || htmlSnapshot(page) === null) return [];
	const byId = new Map(results.map((result) => [result.id, result]));
	const matches = scripts.flatMap((script) => {
		const result = byId.get(script.id);
		if (result === undefined) return [];
		if (result.error !== null)
			return [{ name: script.name, mode: "script_error", count: 0, values: [] }];
		if (result.value === null || result.value.trim() === "") return [];
		return [{ name: script.name, mode: "script", count: 1, values: [result.value] }];
	});
	return matches.length === 0
		? []
		: [finding(page.pageKey, "custom_script", { count: matches.length, matches })];
}

/**
 * The AI prompts' finding of one page: what each prompt answered about its latest text.
 *
 * @param page - The page.
 * @param context - The audit, for the project's prompts and their answers.
 * @returns The finding, or none.
 */
function aiPromptFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const prompts = context.site.aiPrompts ?? [];
	const answers = context.site.aiAnswers?.get(page.pageKey);
	if (prompts.length === 0 || answers === undefined || htmlSnapshot(page) === null) return [];
	const byId = new Map(answers.map((entry) => [entry.promptId, entry.answer]));
	const matches = prompts.flatMap((prompt) => {
		const answer = byId.get(prompt.id);
		return answer === undefined || answer.trim() === ""
			? []
			: [{ name: prompt.name, mode: "prompt", count: 1, values: [answer] }];
	});
	return matches.length === 0
		? []
		: [finding(page.pageKey, "ai_prompt", { count: matches.length, matches })];
}

/**
 * The grammar finding of one page: the problems the grammar check found in its English text.
 *
 * @param page - The page.
 * @returns The finding, or none.
 */
function grammarFindings(page: AuditPage): AuditFinding[] {
	const grammar = page.facts?.checks?.grammar;
	if (grammar == null || grammar.count === 0 || htmlSnapshot(page) === null) return [];
	return [
		finding(page.pageKey, "grammar_errors", {
			count: grammar.count,
			messages: grammar.issues
				.slice(0, GRAMMAR_SHOWN)
				.map((issue) =>
					issue.suggestion === null ? issue.text : `${issue.text} → ${issue.suggestion}`
				)
		})
	];
}

/**
 * The findings over the optional checks of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The findings.
 */
export function pageCheckFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	return [
		...ampFindings(page),
		...customFindings(page, context),
		...scriptFindings(page, context),
		...aiPromptFindings(page, context),
		...grammarFindings(page)
	];
}
