# seostudio

A free SEO site audit from your terminal, from [SEOStudio](https://seostudio.com). No account needed.

It crawls your site from your computer and checks it: broken links and redirects, titles and
descriptions, headings, thin pages, indexability, canonical tags, structured data, images, speed
signals and more. You get a short summary in the terminal and a full report as HTML, JSON or CSV.

With an SEOStudio account it can also send its crawls to your project, give your AI agent one MCP
server for the audit and your SEOStudio tools, and run your scheduled crawls on your own server.

**Privacy:** the audit runs on your computer. It sends nothing anywhere except the requests to the
site it crawls. The CLI collects no usage data.

## Install

You need Node.js 22.19 or later.

```bash
npx seostudio audit example.com
```

Or install it once:

```bash
npm install --global seostudio
```

## 1. `seostudio audit`: audit a site

```bash
seostudio audit example.com
seostudio audit https://example.com/blog/ --max-pages 200 --format csv --out blog.csv
```

| Option | What it does |
| --- | --- |
| `--max-pages N` | The most pages to read (default 500, up to 10,000). |
| `--format html\|json\|csv` | The report format (default `html`). JSON follows a versioned schema (`schemaVersion: 1`). |
| `--out file` | Where to write the report (default `seostudio-audit-<site>.<format>`). |
| `--allow-private` | Let the crawl read the site you named on a private or local address, such as a staging site on your own network. Every other host stays refused. Off by default. |

The summary lists the issues by severity, the issues that touch the most pages, and **thin page
candidates**: pages with little text. The crawl alone cannot tell whether a thin page gets search
traffic, so check Search Console before you merge or remove one. (SEOStudio does this check for you
with your Search Console data.)

The terminal audit skips the TLS certificate check (SEOStudio's servers run it), so its health score
can differ by about a point from the one in your dashboard.

The crawler is polite: it obeys robots.txt, waits between requests, and never reads private,
loopback or cloud metadata addresses, and checks every redirect again (unless you pass
`--allow-private` for your own staging site).

### Save a crawl to your project

With an SEOStudio API key, `--save` crawls from your computer and stores the result in your
project, exactly like a crawl from the SEOStudio desktop app. The project's site audit, history and
recommendations update as after any other crawl.

```bash
seostudio login
seostudio audit example.com --save
seostudio audit example.com --save --project <project id>
```

`--project` is needed only when more than one of your projects is the same site. A site behind a
login (saved sign-in headers or basic auth) is crawled by SEOStudio's servers or the desktop app,
not by the CLI.

## 2. `seostudio login`: save your API key

Create an API key with **Allow MCP access** at
[seostudio.com/settings/developers](https://seostudio.com/settings/developers), then:

```bash
seostudio login
```

The key is read from a hidden prompt (or from stdin), checked with SEOStudio, and saved in your
user's config folder, readable by you only. `seostudio logout` removes it. You can also set the
`SEOSTUDIO_API_KEY` environment variable instead; it is used before the saved key. The CLI never
prints or logs the key.

## 3. `seostudio mcp`: one MCP server for your AI agent

`seostudio mcp` runs a local MCP server over stdio. It always has the audit tools, free and with no
account:

| Tool | What it does |
| --- | --- |
| `local_audit_run` | Crawl a site from your computer and audit it. |
| `local_audit_get` | Read a report: the summary, or the whole report as JSON, CSV or HTML (or write it to a file). |
| `local_audit_issues_list` | List a report's issues by severity, check or page. |

With an API key (saved with `seostudio login` or in `SEOSTUDIO_API_KEY`), it also serves every
SEOStudio tool of your account, so one connector covers both.

**Claude Code:**

```bash
claude mcp add --scope user seostudio -- npx -y seostudio mcp
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "seostudio": { "command": "npx", "args": ["-y", "seostudio", "mcp"] }
  }
}
```

**Codex:**

```bash
codex mcp add seostudio -- npx -y seostudio mcp
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "seostudio": { "command": "npx", "args": ["-y", "seostudio", "mcp"] }
  }
}
```

To pass the key through the app instead of `seostudio login`, add
`"env": { "SEOSTUDIO_API_KEY": "<your key>" }` next to `"args"`. Keep the key in your app's own
config, never in a repository.

## 4. `seostudio agent`: crawl from your own server

SEOStudio crawls your sites from its own servers every day. You can run those scheduled crawls on
your own server instead, for example when your site only lets your own IP addresses in:

1. In SEOStudio, open the site audit's settings and switch on **Run on your own server** (under
   Scheduled crawls). Your agent can do it too: `seo_site_audit_update` with
   `settings.runner: "own_server"`.
2. Run the agent on your server with an API key and the projects it crawls:

```bash
SEOSTUDIO_API_KEY=<your key> npx seostudio agent --project <project id>
```

Every 15 minutes (`--interval` to change it) the agent asks SEOStudio which of the named projects
are due and crawls them from your server. `--once` runs one pass and stops, for a cron job. The
agent crawls only the projects you name with `--project` (repeat it) or `SEOSTUDIO_PROJECTS`
(comma separated).

### Docker

The `Dockerfile` and `compose.example.yaml` in this folder run the agent in a small container as a
non-root user. Put the key and the projects in a `.env` file next to the compose file:

```bash
SEOSTUDIO_API_KEY=<your key>
SEOSTUDIO_PROJECTS=<project id>
```

Then:

```bash
docker compose -f compose.example.yaml up -d --build
```

## License

MIT
