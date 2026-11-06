#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { crawlSite } from "@seostudio/audit-engine";

import { runAgent } from "./agent.js";
import { apiOrigin, seoApi } from "./api.js";
import { parseCommand, USAGE } from "./args.js";
import type { Command } from "./args.js";
import { localAuditTools } from "./audit-tools.js";
import type { CrawlSite } from "./audit-tools.js";
import { configDir, forgetApiKey, resolveApiKey, saveApiKey } from "./config-store.js";
import { createMcpServer, hostedTools } from "./mcp.js";
import { chooseProject, listCrawlProjects } from "./projects.js";
import { defaultReportFile, renderReport } from "./report.js";
import { saveCrawl } from "./save.js";
import type { SaveReader } from "./save.js";
import { formatSummary, summarize } from "./summary.js";
import { CLI_VERSION } from "./version.js";

/**
 * THE `seostudio` COMMAND: parses the line, then runs one command. Everything it reaches outside
 * itself arrives in {@link CliIo}, so a test runs it whole with no network, no files and no terminal.
 * The standalone audit calls nothing but the audited site; there is no telemetry of any kind.
 */

/** The environment variable that names the projects `agent` crawls, comma separated. */
export const PROJECTS_ENV = "SEOSTUDIO_PROJECTS";

/** What the command reaches outside itself. */
export interface CliIo {
	env: Readonly<Record<string, string | undefined>>;
	cwd: string;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Reads the API key `login` saves: hidden at a terminal, else one line of stdin. */
	readSecret: (prompt: string) => Promise<string>;
	/** The standalone crawl; the audit engine's by default. */
	crawl?: CrawlSite;
	/** Writes a report file. */
	writeFile?: (path: string, text: string) => Promise<void>;
	/** The transport to SEOStudio; the global fetch by default. */
	fetch?: typeof fetch;
	/** How `--save` and `agent` read the site; the audit engine's over the network guard by default. */
	reader?: SaveReader;
	/** Waits between two agent passes, cut short by a stop. */
	wait?: (ms: number) => Promise<void>;
	stopRequested?: () => boolean;
	/** Serves the MCP server over stdio until the client goes; injected in tests. */
	serveMcp?: (server: ReturnType<typeof createMcpServer>) => Promise<void>;
}

/**
 * Runs the CLI.
 *
 * @param argv - The arguments after the program name.
 * @param io - What it reaches outside itself.
 * @returns The exit code: 0 done, 1 failed, 2 a refused command line.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
	const parsed = parseCommand(argv);
	if (!parsed.ok) {
		io.err(`${parsed.error}\n`);
		return 2;
	}
	try {
		return await run(parsed.command, io);
	} catch (error) {
		io.err(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/**
 * Runs one parsed command.
 *
 * @param command - The command.
 * @param io - What it reaches outside itself.
 * @returns The exit code.
 */
async function run(command: Command, io: CliIo): Promise<number> {
	switch (command.kind) {
		case "help":
			io.out(`${USAGE}\n`);
			return 0;
		case "version":
			io.out(`${CLI_VERSION}\n`);
			return 0;
		case "audit":
			return command.save ? auditSaved(command, io) : auditHere(command, io);
		case "login":
			return login(io);
		case "logout": {
			const removed = await forgetApiKey(configDir(io.env));
			io.out(removed ? "The saved API key is removed.\n" : "No API key was saved.\n");
			return 0;
		}
		case "mcp":
			return mcp(io);
		case "agent":
			return agent(command, io);
	}
}

/**
 * `audit` on this computer: crawls in-process, writes the report, prints the summary.
 *
 * @param command - The audit command.
 * @param io - What it reaches outside itself.
 * @returns The exit code.
 */
async function auditHere(command: Extract<Command, { kind: "audit" }>, io: CliIo): Promise<number> {
	const crawl = io.crawl ?? crawlSite;
	let lastPhase = "";
	io.err(`Crawling ${command.url} (up to ${String(command.maxPages)} pages)...\n`);
	const report = await crawl({
		url: command.url,
		maxPages: command.maxPages,
		...(command.allowPrivate
			? { allowPrivateHosts: new Set([new URL(command.url).hostname.toLowerCase()]) }
			: {}),
		onProgress: (progress) => {
			if (progress.phase !== lastPhase) {
				lastPhase = progress.phase;
				io.err(`  ${progress.phase}: ${String(progress.pagesRead)} pages read\n`);
			} else if (progress.phase === "pages" && progress.pagesRead > 0 && progress.pagesRead % 50 === 0) {
				io.err(`  pages: ${String(progress.pagesRead)} of ${String(progress.pagesFound)} found\n`);
			}
		}
	});
	const file = resolve(io.cwd, command.out ?? defaultReportFile(command.url, command.format));
	await (io.writeFile ?? ((path, text) => writeFile(path, text, "utf-8")))(
		file,
		renderReport(report, command.format)
	);
	io.out(`${formatSummary(summarize(report))}\n\nReport (${command.format}): ${file}\n`);
	if (report.summary.pages === 0) {
		io.err(
			command.allowPrivate
				? "No page could be read. Check the address and that the site answers.\n"
				: "No page could be read. Check the address; a site on a private or local address needs --allow-private.\n"
		);
	}
	return 0;
}

/**
 * The API key and the SEO routes it opens, or a refusal printed.
 *
 * @param io - What it reaches outside itself.
 * @returns The origin and the routes, or null when there is no key.
 */
async function keyedApi(
	io: CliIo
): Promise<{ origin: string; api: ReturnType<typeof seoApi> } | null> {
	const key = await resolveApiKey(io.env, configDir(io.env));
	if (key === null) {
		io.err(
			"This needs an SEOStudio API key with MCP access: run `seostudio login`, or set SEOSTUDIO_API_KEY.\n"
		);
		return null;
	}
	const origin = apiOrigin(io.env);
	return { origin, api: seoApi({ origin, key: key.key, ...(io.fetch === undefined ? {} : { fetch: io.fetch }) }) };
}

/**
 * `audit --save`: crawls from this computer into the user's SEOStudio project.
 *
 * @param command - The audit command.
 * @param io - What it reaches outside itself.
 * @returns The exit code.
 */
async function auditSaved(command: Extract<Command, { kind: "audit" }>, io: CliIo): Promise<number> {
	const keyed = await keyedApi(io);
	if (keyed === null) return 1;
	const listed = await listCrawlProjects(keyed.api);
	if (!listed.ok) {
		io.err(`${listed.error}\n`);
		return 1;
	}
	const chosen = chooseProject(listed.projects, command.url, command.project);
	if (!chosen.ok) {
		io.err(`${chosen.error}\n`);
		return 1;
	}
	const { project } = chosen;
	io.err(`Crawling ${project.urlHost ?? command.url} into project ${project.name}...\n`);
	let lastPhase = "";
	const result = await saveCrawl({
		projectId: project.id,
		siteHost: project.urlHost ?? new URL(command.url).hostname,
		api: keyed.api,
		reader: io.reader ?? (await defaultReader()),
		...(io.stopRequested === undefined ? {} : { stopRequested: io.stopRequested }),
		onProgress: (progress) => {
			if (progress.phase !== lastPhase) {
				lastPhase = progress.phase;
				io.err(`  ${progress.phase}: ${String(progress.checked)} pages checked\n`);
			}
		}
	});
	if (!result.ok) {
		io.err(`${result.error}\n`);
		return 1;
	}
	const lines = [
		`Saved to ${project.name}: ${String(result.checked)} pages checked.`,
		result.auditQueued
			? "The audit is running on SEOStudio; it shows in a few minutes."
			: `Health score: ${result.healthScore === null ? "-" : String(result.healthScore)}. Open issues: ${result.open === null ? "-" : String(result.open)}. Fixed: ${result.fixed === null ? "-" : String(result.fixed)}.`,
		...(result.capped ? ["The crawl stopped at your plan's pages per run."] : []),
		`See it in SEOStudio: ${keyed.origin}/seo/site-audit`
	];
	io.out(`${lines.join("\n")}\n`);
	return 0;
}

/**
 * The audit engine's reader over the network guard, loaded only when a crawl is saved.
 *
 * @returns The reader.
 */
async function defaultReader(): Promise<SaveReader> {
	const { engineReader } = await import("./reader.js");
	return engineReader();
}

/**
 * `login`: reads an API key, checks it with SEOStudio, and saves it for this user only.
 *
 * @param io - What it reaches outside itself.
 * @returns The exit code.
 */
async function login(io: CliIo): Promise<number> {
	const key = (await io.readSecret("SEOStudio API key (input hidden): ")).trim();
	if (key === "") {
		io.err("No key given. Create one with Allow MCP access at seostudio.com/settings/developers.\n");
		return 1;
	}
	const origin = apiOrigin(io.env);
	const checked = await listCrawlProjects(
		seoApi({ origin, key, ...(io.fetch === undefined ? {} : { fetch: io.fetch }) })
	);
	if (!checked.ok) {
		io.err(`${checked.error} The key was not saved.\n`);
		return 1;
	}
	const file = await saveApiKey(key, configDir(io.env));
	io.out(
		`Saved. The key reaches ${String(checked.projects.length)} ${checked.projects.length === 1 ? "project" : "projects"}. Stored in ${file} (readable by you only).\n`
	);
	return 0;
}

/**
 * `mcp`: the local MCP server over stdio. With an API key it also forwards the hosted tools.
 *
 * @param io - What it reaches outside itself.
 * @returns The exit code once the client goes.
 */
async function mcp(io: CliIo): Promise<number> {
	const key = await resolveApiKey(io.env, configDir(io.env));
	const hosted =
		key === null
			? null
			: hostedTools({
					origin: apiOrigin(io.env),
					key: key.key,
					...(io.fetch === undefined ? {} : { fetch: io.fetch })
				});
	const server = createMcpServer({
		local: localAuditTools(io.crawl ?? crawlSite, io.cwd),
		hosted,
		warn: (line) => {
			io.err(`${line}\n`);
		}
	});
	const serve =
		io.serveMcp ??
		(async (ready: typeof server) => {
			const transport = new StdioServerTransport();
			const closed = new Promise<void>((done) => {
				transport.onclose = () => {
					done();
				};
				process.stdin.once("end", () => {
					done();
				});
			});
			await ready.connect(transport);
			await closed;
		});
	await serve(server);
	return 0;
}

/**
 * `agent`: runs the due scheduled crawls of the named projects until stopped.
 *
 * @param command - The agent command.
 * @param io - What it reaches outside itself.
 * @returns The exit code.
 */
async function agent(command: Extract<Command, { kind: "agent" }>, io: CliIo): Promise<number> {
	const projects =
		command.projects.length > 0
			? command.projects
			: (io.env[PROJECTS_ENV] ?? "")
					.split(",")
					.map((entry) => entry.trim())
					.filter((entry) => entry !== "");
	if (projects.length === 0) {
		io.err(
			`Name the projects this agent crawls: --project <id> (repeat it for more), or ${PROJECTS_ENV}=id1,id2.\n`
		);
		return 2;
	}
	const keyed = await keyedApi(io);
	if (keyed === null) return 1;
	return runAgent({
		api: keyed.api,
		reader: io.reader ?? (await defaultReader()),
		projects,
		once: command.once,
		intervalMinutes: command.intervalMinutes,
		log: (line) => {
			io.out(`${line}\n`);
		},
		wait: io.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
		stopRequested: io.stopRequested ?? (() => false)
	});
}

/**
 * Reads a secret: hidden at a terminal, else the first line of stdin.
 *
 * @param prompt - What the terminal shows.
 * @returns The text typed.
 */
function readSecret(prompt: string): Promise<string> {
	const input = process.stdin;
	if (!input.isTTY) {
		return new Promise((done) => {
			const lines = createInterface({ input });
			let answered = false;
			lines.once("line", (line) => {
				answered = true;
				lines.close();
				done(line);
			});
			lines.once("close", () => {
				if (!answered) done("");
			});
		});
	}
	return new Promise((done) => {
		process.stderr.write(prompt);
		input.setRawMode(true);
		input.resume();
		let typed = "";
		const onData = (chunk: Uint8Array | string): void => {
			const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			for (const char of text) {
				if (char === "\r" || char === "\n" || char === "\u0004") {
					input.setRawMode(false);
					input.pause();
					input.off("data", onData);
					process.stderr.write("\n");
					done(typed);
					return;
				}
				if (char === "\u0003") {
					input.setRawMode(false);
					process.stderr.write("\n");
					process.exit(130);
				}
				typed = char === "\u007F" ? typed.slice(0, -1) : typed + char;
			}
		};
		input.on("data", onData);
	});
}

/**
 * Whether this file is the program being run (not imported by a test).
 *
 * @returns Whether it is.
 */
function isEntry(): boolean {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	return /(?:^|[\\/])(?:cli\.[cm]?[jt]s|seostudio)$/.test(entry);
}

if (isEntry()) {
	let stopping = false;
	const waiters = new Set<() => void>();
	const stop = (): void => {
		if (stopping) process.exit(130);
		stopping = true;
		for (const wake of waiters) wake();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	const code = await main(process.argv.slice(2), {
		env: process.env,
		cwd: process.cwd(),
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
		readSecret,
		stopRequested: () => stopping,
		wait: (ms) =>
			new Promise<void>((done) => {
				const timer = setTimeout(finish, ms);
				function finish(): void {
					clearTimeout(timer);
					waiters.delete(finish);
					done();
				}
				waiters.add(finish);
			})
	});
	process.exitCode = code;
}
