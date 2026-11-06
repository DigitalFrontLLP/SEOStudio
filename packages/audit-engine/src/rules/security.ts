import { UPGRADE_INSECURE } from "../extract";
import { AUDIT_EXAMPLES, finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditSitePage } from "./types";

/**
 * THE SECURITY RULES: mixed content on a page, and the security headers the home page answers with.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - mixed content counts only on a page served over https; a LINK to an http page is navigation and
 *   never counts (the extractor leaves it out). Active content (scripts, frames, stylesheets) is an
 *   error, since browsers block it; passive content (images, media) is a notice. A page whose
 *   Content-Security-Policy (header or meta) says `upgrade-insecure-requests` loads every resource over
 *   https, so it has none;
 * - the headers are judged once, on the home page, and only the ones that protect every site: HSTS
 *   (on https), `X-Content-Type-Options: nosniff`, and frame protection (`X-Frame-Options` or a CSP
 *   `frame-ancestors`). A missing Content-Security-Policy or Referrer-Policy is never flagged (browsers
 *   default the referrer safely, and a CSP is a per-site design choice). It is a notice: it does not
 *   change rankings;
 * - a form is insecure only where its data would travel unencrypted: posted to an http address from an
 *   https page, or shown on a page served over http (a password field there is named apart);
 * - `//host/...` resources are a notice: they follow the page's own protocol, harmless on https;
 * - the certificate is judged from the server's own handshake with the site's host: one that expires
 *   within {@link CERTIFICATE_DAYS} days or no longer verifies, a protocol before TLS 1.2, or a broken
 *   cipher (RC4, DES, 3DES, NULL, EXPORT, MD5).
 */

/** How many days before a certificate expires it is flagged. */
const CERTIFICATE_DAYS = 14;

/** The protocols browsers no longer accept. */
const WEAK_PROTOCOLS = new Set(["sslv2", "sslv3", "tlsv1", "tlsv1.1"]);

/** The cipher suites considered broken. */
const WEAK_CIPHER = /(?:^|[_-])(?:rc4|des|3des|des-cbc3|null|export|exp|md5)(?:[_-]|$)/i;

/** A day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Whether the page answered over https.
 *
 * @param page - The page.
 * @returns Whether it did (true when the final URL is unknown, the crawler asks over https).
 */
function servedOverHttps(page: AuditSitePage): boolean {
	const final = page.snapshot?.finalUrl ?? page.facts?.redirectChain.at(-1)?.url ?? null;
	return final === null || /^https:/i.test(final);
}

/**
 * The mixed content findings of one page.
 *
 * @param page - The page.
 * @returns Its findings.
 */
export function mixedContentFindings(page: AuditPage): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	const mixed = page.facts?.mixedContent ?? null;
	if (snapshot === null || mixed === null || !servedOverHttps(page)) return [];
	if (UPGRADE_INSECURE.test(page.facts?.headers.contentSecurityPolicy ?? "")) return [];
	const found: AuditFinding[] = [];
	const examples = mixed.examples;
	if (mixed.active > 0)
		found.push(finding(page.pageKey, "mixed_content_active", { count: mixed.active, examples }));
	if (mixed.passive > 0)
		found.push(finding(page.pageKey, "mixed_content_passive", { count: mixed.passive, examples }));
	return found;
}

/**
 * The security headers the home page lacks, or null when it was not read.
 *
 * @param page - The home page.
 * @returns The missing header names.
 */
export function missingSecurityHeaders(page: AuditSitePage): string[] | null {
	const facts = page.facts ?? null;
	if (facts === null || htmlSnapshot(page) === null) return null;
	const headers = facts.headers;
	const missing: string[] = [];
	if (servedOverHttps(page) && (headers.strictTransportSecurity ?? "").trim() === "")
		missing.push("strict-transport-security");
	if ((headers.xContentTypeOptions ?? "").trim().toLowerCase() !== "nosniff")
		missing.push("x-content-type-options");
	const frameAncestors = /(?:^|;)\s*frame-ancestors\s/i.test(headers.contentSecurityPolicy ?? "");
	if ((headers.xFrameOptions ?? "").trim() === "" && !frameAncestors)
		missing.push("x-frame-options");
	return missing;
}

/**
 * The whole-site security headers finding, filed on the home page.
 *
 * @param context - The audit.
 * @returns The finding, or nothing.
 */
export function securityHeaderFindings(context: AuditContext): AuditFinding[] {
	const homeKey = context.site.homeKey;
	if (homeKey === null) return [];
	const home = context.byKey.get(homeKey) ?? context.byKey.get(context.resolve(homeKey));
	if (home === undefined) return [];
	const missing = missingSecurityHeaders(home);
	if (missing === null || missing.length === 0) return [];
	return [finding(homeKey, "security_headers_missing", { headers: missing })];
}

/**
 * Whether a URL is plain http.
 *
 * @param url - The URL as written.
 * @returns Whether it is.
 */
function plainHttp(url: string): boolean {
	return /^http:/i.test(url.trim());
}

/**
 * The transport findings of one page: forms whose data travels unencrypted, and resources loaded with
 * a protocol-relative URL.
 *
 * @param page - The page.
 * @returns Its findings.
 */
export function transportFindings(page: AuditPage): AuditFinding[] {
	const markup = page.facts?.markup ?? null;
	if (htmlSnapshot(page) === null || markup === null) return [];
	const found: AuditFinding[] = [];
	const https = servedOverHttps(page);
	const kinds: string[] = [];
	const passwordField = markup.forms.some((form) => form.password) || markup.passwordOutsideForm;
	if (!https && passwordField) kinds.push("password_http");
	else if (!https && markup.formCount > 0) kinds.push("page_http");
	const posting = markup.forms.filter((form) => plainHttp(form.action));
	if (https && posting.length > 0) kinds.push("action_http");
	if (kinds.length > 0)
		found.push(
			finding(page.pageKey, "form_insecure", {
				kinds,
				actions: posting.slice(0, AUDIT_EXAMPLES).map((form) => form.action)
			})
		);
	if (markup.protocolRelative.count > 0)
		found.push(
			finding(page.pageKey, "protocol_relative_resources", {
				count: markup.protocolRelative.count,
				examples: markup.protocolRelative.examples
			})
		);
	return found;
}

/**
 * The whole-site transport finding, filed on the home page: the certificate and handshake the server
 * read.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function tlsFindings(context: AuditContext): AuditFinding[] {
	const homeKey = context.site.homeKey;
	if (homeKey === null) return [];
	const found: AuditFinding[] = [];
	const tls = context.site.tls ?? null;
	if (tls !== null) {
		const kinds: string[] = [];
		const checked = Date.parse(tls.checkedAt);
		const expires = tls.validTo === null ? Number.NaN : Date.parse(tls.validTo);
		const daysLeft =
			Number.isFinite(expires) && Number.isFinite(checked)
				? Math.floor((expires - checked) / DAY_MS)
				: null;
		if (daysLeft !== null && daysLeft < 0) kinds.push("expired");
		else if (daysLeft !== null && daysLeft < CERTIFICATE_DAYS) kinds.push("expiring");
		if (!tls.authorized && !kinds.includes("expired")) kinds.push("invalid");
		if (WEAK_PROTOCOLS.has((tls.protocol ?? "").toLowerCase())) kinds.push("weak_protocol");
		if (WEAK_CIPHER.test(tls.cipher ?? "")) kinds.push("weak_cipher");
		if (kinds.length > 0)
			found.push(
				finding(homeKey, "tls_certificate", {
					kinds,
					validTo: tls.validTo,
					daysLeft,
					protocol: tls.protocol,
					cipher: tls.cipher,
					error: tls.error
				})
			);
	}
	return found;
}
