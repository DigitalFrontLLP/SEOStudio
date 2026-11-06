/**
 * Whether a page key (`host/path`) is on a project's own site: its host or a subdomain of it, a
 * leading `www.` aside. A saved crawl reads nothing else a server names.
 *
 * @param pageKey - The page key the server handed out.
 * @param siteHost - The project's host.
 * @returns Whether this computer may read it for the project.
 */
export function onProjectSite(pageKey: string, siteHost: string): boolean {
	let host: string;
	try {
		host = new URL(`https://${pageKey}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	const site = siteHost.toLowerCase().replace(/^www\./, "");
	const bare = host.replace(/^www\./, "");
	return bare === site || bare.endsWith(`.${site}`);
}
