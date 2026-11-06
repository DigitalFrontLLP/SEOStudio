# @seostudio/audit-engine

The site audit engine behind [SEOStudio](https://seostudio.com): a polite crawler and the audit's
checks, in TypeScript, with no database and no account. MIT licensed.

It reads a site the way a search engine does: robots.txt and the sitemaps first, then every page it
can reach from the home page, then what those pages load and link out to. Every check files a stable
rule id (`title_missing`, `broken_internal_links`, `redirect_chain`...) with its evidence as data, so
you can store, compare or word the results as you like.

## Install

```bash
npm install @seostudio/audit-engine
```

It is an ES module with its own types, for Node.js 22.19 or later. For the command line, use the
[`seostudio` CLI](https://github.com/DigitalFrontLLP/SEOStudio/tree/main/packages/cli) instead: `npx seostudio audit example.com`.

## Crawl a site

```ts
import { crawlSite, renderHtmlReport, toCsv } from "@seostudio/audit-engine";
import { writeFile } from "node:fs/promises";

const report = await crawlSite({
	url: "https://example.com/",
	maxPages: 200,
	onProgress: (progress) => console.log(progress.phase, progress.pagesRead)
});

console.log(report.summary.score, report.summary.bySeverity);
await writeFile("audit.html", renderHtmlReport(report));
await writeFile("audit.csv", toCsv(report));
```

`crawlSite` runs every check that needs no paid data or account data. The checks that join Google
Search Console, Analytics or lab tests stay quiet without that data.

## The report

`AuditReport` is plain JSON, versioned by `schemaVersion` (now `1`):

- `pages`: every page read, with its status, title, click depth and issue count;
- `issues`: every finding, with its `ruleId`, `severity` (`critical`, `warning` or `notice`),
  `category`, `kind` (`issue` or `tip`), `page` and `evidence`;
- `summary`: the counts by severity and rule, and the site's health score (0 to 100).

## Read one page

`readPage(url, options)` makes one page's reading exactly as the SEOStudio desktop app does, so a
client can fetch a page from its own address and send the reading to a server that judges it.

## The crawler

The crawler obeys robots.txt (its own group, `SiteSnapshot`, then `*`), keeps to the site's
`Crawl-delay` (one second between requests at least), backs off when a site answers 429 or 503, and
never follows a URL that looks like a crawl trap.
