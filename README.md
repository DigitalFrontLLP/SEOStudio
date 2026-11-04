# SEOStudio skills

Open-source SEO skills for your AI agent, from [SEOStudio](https://seostudio.com).

Add them to Claude Code, Codex, Cursor or any app that reads Agent Skills. Your agent then does the
SEO work on your site: keyword research, a content plan, new pages, technical fixes, links and AI
visibility.

The skills use SEOStudio's MCP server for their data: Google results, keyword volumes, your Search
Console and a crawl of your site. A free SEOStudio account is enough to start.

## 1. Install the skills

```bash
npx skills add DigitalFrontLLP/SEOStudio
```

To install one skill only:

```bash
npx skills add DigitalFrontLLP/SEOStudio --skill seostudio-keyword-research
```

## 2. Connect the MCP server

Create a free account at [seostudio.com](https://seostudio.com). Then add this MCP server to your AI
app:

```text
https://seostudio.com/api/mcp
```

You sign in with your SEOStudio account in the browser (OAuth). You do not need a key.

- **Claude Code:** `claude mcp add --transport http --scope user seostudio https://seostudio.com/api/mcp`,
  then run `/mcp` and sign in.
- **Codex:** `codex mcp add seostudio --url https://seostudio.com/api/mcp`, then
  `codex mcp login seostudio`.
- **Cursor:** add `"seostudio": { "url": "https://seostudio.com/api/mcp" }` under `"mcpServers"` in
  `~/.cursor/mcp.json`.
- **Other apps:** add a remote MCP server (streamable HTTP) with the URL above.

No browser, for example on a server or in CI? Create an API key with **Allow MCP access** at
[seostudio.com/settings/developers](https://seostudio.com/settings/developers) and send it in the
`x-api-key` header. Keep the key in your app's secret settings, never in a repository.

After you sign in, [Settings > MCP](https://seostudio.com/settings/mcp) shows the steps for each app.

## 3. Start

Ask your agent: **"What should I do next on my site?"** The `seostudio-seo-guide` skill finds the
next step and runs the skill that does it.

## The skills

| Skill | What it does |
| --- | --- |
| `seostudio-ai-visibility` | See how often AI assistants like ChatGPT mention and recommend your site |
| `seostudio-content-planner` | Plan the pages your site needs, what to write first and how to link them |
| `seostudio-content-writer` | Write or improve one page of your content plan, then publish it |
| `seostudio-find-link-sources` | Find more free places that can link to your site |
| `seostudio-fix-my-site` | Fix the technical problems found on your site |
| `seostudio-keyword-research` | Find, price and pick the keywords your site should target |
| `seostudio-link-outreach` | Pitch sites that link to your competitors |
| `seostudio-link-submissions` | Submit your site to the sources that fit it |
| `seostudio-parasite-post` | Rank on big sites with posts that link to you |
| `seostudio-pick-main-keyword` | Choose the one main keyword your site should rank for first |
| `seostudio-project-profile` | Write your site's profile and list its competitors |
| `seostudio-seo-guide` | Start here: what this app can do for your site and where to begin |
| `seostudio-seo-plan` | Run your SEO plan step by step: the one next step, then the skill that does it |
| `seostudio-seo-report` | Turn your site's data into one clean report you can read, print and share |

## Costs

The skills are free. Some SEOStudio tools get paid data, such as keyword volumes and Google results.
They are paid from your SEOStudio balance, and your agent tells you the price before it runs one.
Reading data you already have is free.

## Changes

This repository is published from SEOStudio's own codebase, so a pull request here is not merged
directly. Open an issue with your idea or fix and we will add it there.

## License

[MIT](LICENSE), copyright Digital Front LLP.
