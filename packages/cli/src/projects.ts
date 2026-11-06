import { z } from "zod";

import type { SeoApi } from "./api.js";

/** One project the API key reaches, as SEOStudio lists it for crawls on your own machines. */
export interface CrawlProject {
	id: string;
	name: string;
	urlHost: string | null;
	runner: "cloud" | "own_server";
	/** Whether a scheduled crawl is due on your own server now. */
	due: boolean;
	lastCrawlAt: string | null;
}

/** The list's answer. */
const listAnswer = z.object({
	projects: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			urlHost: z.string().nullable(),
			runner: z.enum(["cloud", "own_server"]),
			due: z.boolean(),
			lastCrawlAt: z.string().nullable()
		})
	)
});

/** Why the list could not be read. */
export type ProjectsFailure = "signed_out" | "forbidden" | "unreachable" | "server";

/** The projects, or why they could not be read. */
export type ProjectsResult =
	| { ok: true; projects: CrawlProject[] }
	| { ok: false; code: ProjectsFailure; error: string };

/** What each failure tells the person. */
export const PROJECTS_FAILURE_TEXT: Readonly<Record<ProjectsFailure, string>> = {
	signed_out: "The API key was refused. Check it, or run `seostudio login` again.",
	forbidden:
		"This API key has no MCP access. Create one with Allow MCP access at seostudio.com/settings/developers.",
	unreachable: "SEOStudio could not be reached. Check your connection and try again.",
	server: "SEOStudio answered with an error. Try again in a minute."
};

/**
 * Reads every project the API key reaches, with where each one's scheduled crawls run.
 *
 * @param api - The SEO routes, with the key.
 * @returns The projects, or why not.
 */
export async function listCrawlProjects(api: SeoApi): Promise<ProjectsResult> {
	let answer: Awaited<ReturnType<SeoApi>>;
	try {
		answer = await api("GET", "/local-crawls");
	} catch {
		return { ok: false, code: "unreachable", error: PROJECTS_FAILURE_TEXT.unreachable };
	}
	if (answer.status === 401) {
		return { ok: false, code: "signed_out", error: PROJECTS_FAILURE_TEXT.signed_out };
	}
	if (answer.status === 403) {
		return { ok: false, code: "forbidden", error: PROJECTS_FAILURE_TEXT.forbidden };
	}
	const parsed = listAnswer.safeParse(answer.body);
	if (answer.status !== 200 || !parsed.success) {
		return { ok: false, code: "server", error: PROJECTS_FAILURE_TEXT.server };
	}
	return { ok: true, projects: parsed.data.projects };
}

/**
 * The host of a site address, without a leading `www.`.
 *
 * @param url - The address.
 * @returns The host, lowercased, or null.
 */
function bareHost(url: string): string | null {
	try {
		return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname
			.toLowerCase()
			.replace(/^www\./, "");
	} catch {
		return null;
	}
}

/**
 * Whether a project is the one a person named: its id, or its site's domain.
 *
 * @param project - The project.
 * @param reference - The id or domain given.
 * @returns Whether it is.
 */
export function isNamedProject(project: CrawlProject, reference: string): boolean {
	if (project.id === reference) return true;
	const named = bareHost(reference);
	return named !== null && project.urlHost !== null && bareHost(project.urlHost) === named;
}

/**
 * The project a `--save` crawl goes to: the one `--project` names (its id, or its site's domain), else
 * the one project whose site is the audited site's host.
 *
 * @param projects - The projects the key reaches.
 * @param siteUrl - The site the person asked to audit.
 * @param chosen - What `--project` named, or null.
 * @returns The project, or a sentence saying how to choose one.
 */
export function chooseProject(
	projects: readonly CrawlProject[],
	siteUrl: string,
	chosen: string | null
): { ok: true; project: CrawlProject } | { ok: false; error: string } {
	const host = bareHost(siteUrl);
	if (chosen !== null) {
		const byId = projects.find((project) => project.id === chosen);
		const chosenHost = bareHost(chosen);
		const byHost = projects.filter(
			(project) => project.urlHost !== null && bareHost(project.urlHost) === chosenHost
		);
		const project = byId ?? (byHost.length === 1 ? byHost[0] : undefined);
		if (project === undefined) {
			return {
				ok: false,
				error:
					byHost.length > 1
						? `More than one project uses ${chosen}; give the project's id with --project.`
						: `No project ${chosen} for this API key.`
			};
		}
		if (project.urlHost !== null && bareHost(project.urlHost) !== host) {
			return {
				ok: false,
				error: `Project ${project.name} is the site ${project.urlHost}; --save crawls the project's own site.`
			};
		}
		return { ok: true, project };
	}
	const matches = projects.filter(
		(project) => project.urlHost !== null && bareHost(project.urlHost) === host
	);
	if (matches.length === 1 && matches[0] !== undefined) return { ok: true, project: matches[0] };
	if (matches.length > 1) {
		return {
			ok: false,
			error: `More than one project uses ${host ?? siteUrl}; choose one with --project <id>: ${matches
				.map((project) => `${project.id} (${project.name})`)
				.join(", ")}.`
		};
	}
	return {
		ok: false,
		error: `None of your projects is ${host ?? siteUrl}. Add the site in SEOStudio first, or audit it without --save.`
	};
}
