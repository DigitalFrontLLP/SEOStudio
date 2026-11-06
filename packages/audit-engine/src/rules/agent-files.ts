import { finding } from "./page-state";
import type { AuditContext, AuditFinding } from "./types";

/**
 * THE AI AGENT FILE RULES, filed on the home page from the plan's read of the site's files for AI
 * agents (`../agent-files`). Whether AI crawlers may fetch the site is the crawler access rules' job
 * (`./ai-access`), never judged here.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a file the site does not have (a 404, or the site's catch-all page answering for it) is absent,
 *   never broken: only a file the site does serve is judged;
 * - `llms_txt_invalid` (an insight) names an `/llms.txt` that answers a 5xx, an HTML page where the
 *   site has no catch-all, or text without the H1 or the links the format asks for;
 * - `well_known_invalid` names a declared agent file under `/.well-known/` that is not valid JSON, or
 *   an HTML page where the site has no catch-all;
 * - `markdown_alternate_missing` (an insight) says the home page offers no markdown version: neither a
 *   `rel="alternate" type="text/markdown"` link nor markdown for an `Accept: text/markdown` request.
 */

/** The `/llms.txt` outcomes that make it broken. */
const LLMS_BROKEN: ReadonlySet<string> = new Set(["server_error", "soft_404", "no_h1", "no_links"]);

/** The agent file outcomes that make one invalid. */
const WELL_KNOWN_BROKEN: ReadonlySet<string> = new Set(["invalid_json", "soft_404"]);

/**
 * The AI agent file findings of the site.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function agentFileFindings(context: AuditContext): AuditFinding[] {
	const home = context.site.homeKey;
	const files = context.site.agentFiles ?? null;
	if (home === null || files === null) return [];
	const found: AuditFinding[] = [];
	const llms = files.files.find((file) => file.path === "/llms.txt");
	if (llms !== undefined && LLMS_BROKEN.has(llms.outcome)) {
		found.push(
			finding(home, "llms_txt_invalid", {
				kind: llms.outcome,
				...(llms.status === null ? {} : { status: llms.status })
			})
		);
	}
	const invalid = files.files.filter(
		(file) => file.path.startsWith("/.well-known/") && WELL_KNOWN_BROKEN.has(file.outcome)
	);
	if (invalid.length > 0) {
		found.push(
			finding(home, "well_known_invalid", {
				count: invalid.length,
				urls: invalid.map((file) => `https://${home.split("/")[0] ?? home}${file.path}`)
			})
		);
	}
	const homePage = context.byKey.get(home);
	const markup = homePage?.facts?.markup;
	if (
		markup != null &&
		markup.markdownAlternate !== undefined &&
		markup.markdownAlternate === null &&
		!files.markdownNegotiated
	) {
		found.push(finding(home, "markdown_alternate_missing", {}));
	}
	return found;
}
