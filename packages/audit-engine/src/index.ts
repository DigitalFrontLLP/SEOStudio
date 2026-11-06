/**
 * THE SEOSTUDIO AUDIT ENGINE (`@seostudio/audit-engine`): a polite site crawler and the site audit's
 * rules, with no database, no environment and no account. MIT.
 *
 * - {@link crawlSite}: crawls a site in this process and runs every rule that needs no paid data,
 *   into an {@link AuditReport}.
 * - {@link readPage}: one page's reading, exactly as the SEOStudio desktop app makes it, so a client
 *   can fetch a page from its own address and hand the reading to a server that judges it.
 * - {@link renderHtmlReport} and {@link toCsv}: a report as a standalone HTML page or as CSV.
 * - {@link guardedFetch}: the crawler's default transport, which never reaches a private, local or
 *   reserved address (opt out with `allowPrivateHosts` for a staging site you own).
 */

export { AUDIT_REPORT_SCHEMA_VERSION, renderHtmlReport, toCsv } from "./report";
export type {
	AuditReport,
	AuditReportIssue,
	AuditReportKind,
	AuditReportPage,
	AuditReportSeverity,
	AuditReportSummary
} from "./report";
export { BlockedUrlError, createGuardedFetch, guardedFetch, isBlockedAddress } from "./guard";
export type { BlockedUrlReason, GuardedFetchOptions } from "./guard";
export { crawlSite, readPage } from "./site";
export type { CrawlSiteOptions, CrawlSiteProgress, PageReading, ReadPageOptions } from "./site";
