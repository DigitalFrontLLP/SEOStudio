import { parseArgs } from "node:util";

/** The report formats `audit` can write. */
export const REPORT_FORMATS = ["html", "json", "csv"] as const;

/** One report format. */
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** The most pages one standalone audit may crawl. */
export const MAX_PAGES_LIMIT = 10_000;

/** The pages a standalone audit crawls when `--max-pages` is not given. */
export const DEFAULT_MAX_PAGES = 500;

/** The shortest pause `agent` may wait between two passes, in minutes. */
export const MIN_AGENT_INTERVAL_MINUTES = 5;

/** The pause `agent` waits between two passes when `--interval` is not given, in minutes. */
export const DEFAULT_AGENT_INTERVAL_MINUTES = 15;

/** A parsed command line: one command and its options. */
export type Command =
	| {
			kind: "audit";
			url: string;
			maxPages: number;
			format: ReportFormat;
			out: string | null;
			save: boolean;
			project: string | null;
			/** Whether the start URL's host may be on a private or local address (a staging site on this network). */
			allowPrivate: boolean;
	  }
	| { kind: "login" }
	| { kind: "logout" }
	| { kind: "mcp" }
	| {
			kind: "agent";
			once: boolean;
			intervalMinutes: number;
			/** The projects this agent crawls, as `--project` named them; none means the environment's. */
			projects: string[];
	  }
	| { kind: "help"; topic: string | null }
	| { kind: "version" };

/** What parsing answers: the command, or why the command line was refused. */
export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

/** The usage text `help` prints. */
export const USAGE = `seostudio - free SEO site audit from your terminal

Usage:
  seostudio audit <url> [--max-pages N] [--format html|json|csv] [--out file] [--allow-private]
  seostudio audit <url> --save [--project <id or domain>]
  seostudio login
  seostudio logout
  seostudio mcp
  seostudio agent --project <id> [--project <id>...] [--once] [--interval minutes]

Commands:
  audit    Crawl a site on this computer and write a report. No account needed.
           --save sends the crawl to your SEOStudio project instead (needs an API key).
  login    Save an SEOStudio API key on this computer (read from the prompt or stdin).
  logout   Remove the saved API key.
  mcp      Run a local MCP server over stdio: the audit tools, plus your SEOStudio
           tools when an API key is set.
  agent    Run the scheduled crawls of the named projects, when they are set to run
           on your own server.

Options:
  --allow-private   Let audit read the site you named on a private or local address
                    (a staging site on your own network). Every other host stays
                    refused. Off by default: the crawler never reads private,
                    loopback or cloud metadata addresses.

Environment:
  SEOSTUDIO_API_KEY    An API key; used before the saved one.
  SEOSTUDIO_PROJECTS   The projects agent crawls, comma separated, when no --project
                       is given.

The audit runs on this computer and sends nothing anywhere except requests to the site
it crawls. No usage data is collected.`;

/**
 * Refusal text for an option the command does not take.
 *
 * @param command - The command.
 * @param flag - The option given.
 * @returns The refusal.
 */
function notAnOption(command: string, flag: string): ParseResult {
	return { ok: false, error: `\`${command}\` does not take --${flag}.` };
}

/**
 * A whole number from an option's text, within bounds.
 *
 * @param text - The option's value.
 * @param min - The least accepted.
 * @param max - The most accepted.
 * @returns The number, or null when the text is not one in range.
 */
function boundedInteger(text: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * A site address as a person types it, made absolute: `example.com` reads as `https://example.com/`.
 *
 * @param text - The address given.
 * @returns The URL, or null when it names no http(s) site.
 */
export function siteUrlOf(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	if (parsed.hostname === "" || parsed.username !== "" || parsed.password !== "") return null;
	return parsed.toString();
}

/**
 * Reads the command line. Every refusal is a sentence a person can act on; nothing runs on a refused
 * line.
 *
 * @param argv - The arguments after the program name.
 * @returns The command, or why it was refused.
 */
export function parseCommand(argv: readonly string[]): ParseResult {
	const [name, ...rest] = argv;
	if (name === undefined || name === "help" || name === "--help" || name === "-h") {
		return { ok: true, command: { kind: "help", topic: rest[0] ?? null } };
	}
	if (name === "--version" || name === "-v" || name === "version") {
		return { ok: true, command: { kind: "version" } };
	}
	let parsed: ReturnType<typeof parseOptions>;
	try {
		parsed = parseOptions(rest);
	} catch (error) {
		return { ok: false, error: optionError(error) };
	}
	const { values, positionals } = parsed;
	if (values.help === true) return { ok: true, command: { kind: "help", topic: name } };
	const given = Object.entries(values)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key);
	const only = (allowed: readonly string[]): ParseResult | null => {
		const extra = given.find((key) => !allowed.includes(key));
		return extra === undefined ? null : notAnOption(name, extra);
	};
	switch (name) {
		case "audit":
			return parseAudit(values, positionals);
		case "login":
		case "logout":
		case "mcp": {
			const refused = only([]);
			if (refused !== null) return refused;
			if (positionals.length > 0) {
				return { ok: false, error: `\`${name}\` takes no arguments.` };
			}
			return { ok: true, command: { kind: name } };
		}
		case "agent": {
			const refused = only(["once", "interval", "project"]);
			if (refused !== null) return refused;
			if (positionals.length > 0) return { ok: false, error: "`agent` takes no arguments." };
			let intervalMinutes = DEFAULT_AGENT_INTERVAL_MINUTES;
			if (values.interval !== undefined) {
				const minutes = boundedInteger(values.interval, MIN_AGENT_INTERVAL_MINUTES, 24 * 60);
				if (minutes === null) {
					return {
						ok: false,
						error: `--interval must be a whole number of minutes from ${String(MIN_AGENT_INTERVAL_MINUTES)} to 1440.`
					};
				}
				intervalMinutes = minutes;
			}
			const projects = (values.project ?? []).map((id) => id.trim()).filter((id) => id !== "");
			return {
				ok: true,
				command: { kind: "agent", once: values.once === true, intervalMinutes, projects }
			};
		}
		default:
			return { ok: false, error: `Unknown command \`${name}\`. Run \`seostudio help\`.` };
	}
}

/**
 * The options every command shares one parser for; each command then refuses the ones it does not take.
 *
 * @param args - The arguments after the command.
 * @returns The options and the positional arguments.
 */
function parseOptions(args: readonly string[]) {
	return parseArgs({
		args: [...args],
		allowPositionals: true,
		strict: true,
		options: {
			"max-pages": { type: "string" },
			format: { type: "string" },
			out: { type: "string" },
			save: { type: "boolean" },
			project: { type: "string", multiple: true },
			"allow-private": { type: "boolean" },
			once: { type: "boolean" },
			interval: { type: "string" },
			help: { type: "boolean", short: "h" }
		}
	});
}

/** The parsed options. */
type Options = ReturnType<typeof parseOptions>["values"];

/**
 * A parser error as a sentence, without the parser's own error code.
 *
 * @param error - What the parser threw.
 * @returns The sentence.
 */
function optionError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const unknown = /Unknown option '([^']+)'/.exec(message);
	if (unknown !== null) return `Unknown option ${unknown[1] ?? ""}. Run \`seostudio help\`.`;
	const missing = /Option '([^']+?)(?: <value>)?' argument missing/.exec(message);
	if (missing !== null) return `${(missing[1] ?? "").split(",").pop()?.trim() ?? ""} needs a value.`;
	return message.replace(/\s*To specify a positional argument.*$/s, "");
}

/**
 * Reads `audit`'s arguments.
 *
 * @param values - The options.
 * @param positionals - The positional arguments.
 * @returns The command, or why it was refused.
 */
function parseAudit(values: Options, positionals: readonly string[]): ParseResult {
	for (const key of ["once", "interval"] as const) {
		if (values[key] !== undefined) return notAnOption("audit", key);
	}
	if (positionals.length === 0) {
		return { ok: false, error: "Give the site to audit: `seostudio audit example.com`." };
	}
	if (positionals.length > 1) return { ok: false, error: "Give one site at a time." };
	const url = siteUrlOf(positionals[0] ?? "");
	if (url === null) {
		return { ok: false, error: `\`${positionals[0] ?? ""}\` is not a website address.` };
	}
	const save = values.save === true;
	if (!save && values.project !== undefined) {
		return { ok: false, error: "--project chooses where --save sends the crawl; add --save." };
	}
	if ((values.project?.length ?? 0) > 1) {
		return { ok: false, error: "--save sends a crawl to one project; give --project once." };
	}
	if (save && values["allow-private"] === true) {
		return {
			ok: false,
			error: "--allow-private is for a report on this computer; --save reads only public addresses."
		};
	}
	if (save && (values.format !== undefined || values.out !== undefined)) {
		return {
			ok: false,
			error:
				"--save keeps the report in your SEOStudio project; --format and --out are for a report on this computer."
		};
	}
	if (save && values["max-pages"] !== undefined) {
		return {
			ok: false,
			error: "--save crawls up to your plan's pages per run; --max-pages is for a report on this computer."
		};
	}
	let maxPages = DEFAULT_MAX_PAGES;
	if (values["max-pages"] !== undefined) {
		const pages = boundedInteger(values["max-pages"], 1, MAX_PAGES_LIMIT);
		if (pages === null) {
			return {
				ok: false,
				error: `--max-pages must be a whole number from 1 to ${String(MAX_PAGES_LIMIT)}.`
			};
		}
		maxPages = pages;
	}
	let format: ReportFormat = "html";
	if (values.format !== undefined) {
		const chosen = REPORT_FORMATS.find((entry) => entry === values.format);
		if (chosen === undefined) {
			return { ok: false, error: `--format must be one of ${REPORT_FORMATS.join(", ")}.` };
		}
		format = chosen;
	}
	const out = values.out === undefined ? null : values.out.trim();
	if (out === "") return { ok: false, error: "--out needs a file name." };
	return {
		ok: true,
		command: {
			kind: "audit",
			url,
			maxPages,
			format,
			out,
			save,
			project: values.project?.[0]?.trim() || null,
			allowPrivate: values["allow-private"] === true
		}
	};
}
