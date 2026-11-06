---
name: seostudio-seo-guide
description: "SEOStudio: The map of this app for an agent working without its pages. Says which skill or tool answers each goal (what to do next, keywords, content plan, writing a page, a weak page, rankings, traffic, site health, AI assistants, competitors, local, reports, a new project), the order the work goes in, what each page of the app shows and which tools read or change it, what runs on its own, what only the app can do, and the money, question and approval rules. Use it when the user asks what to do next, how something works, or names a goal rather than a step."
metadata:
  role: map
  title: Start here
  summary: "Start here: what this app can do for your site and where to begin"
  inputs:
    - name: project
      title: Project
      description: Your site's domain (e.g. example.com), or the project's id or exact name. Left out, your only project is used, or you are asked which one.
      required: true
---

# SEO guide

## Goal

Answer the user's goal the way the app would, with this app's tools. This page is a map: it picks
the skill or tools for the goal. When it names a skill, read it with `skill_get` and follow it; its
rules win over this page.

## Rules every skill shares

- **Questions** go through your question tool, one at a time, the recommended answer first. Never
  end on a question written in prose.
- **Short.** A few lines of facts, then one next action offered with the question tool.
- When you must stop, say in one line what is missing, then ask for it.
- **Money.** Paid tools state their price; `estimate: true` prices a call and buys
  nothing. Say the price before a paid call (`~$0.40`) and the cost after, in dollars. The user's
  money is their balance (`account_status_get`), never "credits". Reads of held data are free.
- **Market and language.** The tools have NO default market or language: take both from the
  project (`projects_get`).
- **The user's own site.** Never change or publish anything on it
  unless the user asked for that specific change. SEO-critical changes (indexing, canonicals,
  redirects, page addresses, unpublishing, overwriting a live page) wait for their OK:
  - In the app's chat the user answers an Approve card; elsewhere your client may ask the user
    itself.
  - `status: "approval_required"`: nothing changed yet. Show its `changes`, ask in the chat, and
    only on a yes send the same call again with its `approval_code` value. `approval_declined`: they said no.
- **Deletes.** Before deleting something the user may want to keep, confirm with one question.
- **Numbers come from the tools.** Never estimate the clicks a change will bring.
- **Reports.** Any result the user wants to read, print or share as a report: the `seo-report`
  skill (read it with `skill_get`).
- **Background work.** While an answer's `status` is `running` or `waiting`, wait `checkAgainInSeconds`, then call once.

## Where to start, by goal

| The user asks | Start with |
| --- | --- |
| What should I do next? | `seo_overview_get`: every area in one read, with the app's suggestions (Do next) and their facts. The suggestions are one input; weigh them against the data and pick the step. A plan step to run: the `seo-plan` skill |
| A new site | `projects_create`, the `project-profile` skill, then the `seo-plan` skill |
| Change the site's profile, markets or competitors | the `project-profile` skill (`projects_update`) |
| Keywords | the `keyword-research` skill |
| How big is my market, how do I compare with my competitors? | `seo_competitors_get` (free, after keyword research) |
| The main keyword | the `pick-main-keyword` skill |
| Do AI assistants mention us? | `seo_ai_visibility_get` (free); a new run is the `ai-visibility` skill |
| Plan content, silos, internal links | the `content-planner` skill |
| Write, improve or publish a page | the `content-writer` skill (no page named: the planner's next page) |
| The weakest page | `seo_actions_list`, `seo_dashboard_get` lenses `losing`, `quick_wins`, `improve_or_remove`, then `seo_pages_get`. Its words: `content-writer`; a technical problem: `fix-my-site` |
| Fix the site, audit issues, broken or missing links | the `fix-my-site` skill |
| Pages with fewer clicks than their position usually gets | `seo_dashboard_get` lens `low_ctr`: a filter to explore, never advice; Google sometimes answers the search itself |
| Rankings | `seo_rank_tracking_get` (the site's positions come from Search Console; guest posts are checked), and `search_performance_get` or `seo_dashboard_get` for every search |
| Why did traffic drop? | `seo_actions_list`, `seo_dashboard_get` with `compare`, `seo_pages_get` with `results: ["lost"]`, `web_analytics_get` |
| Site health | `seo_site_audit_get`, `seo_site_health_get`, `seo_indexing_get`; fixes: `fix-my-site` |
| A competitor or any domain | `seo_site_explorer_get` (`estimate` first); `opportunities` is free |
| Links to win | `seo_site_explorer_get` sections `link_gap`, `broken_backlinks`, `referring_domains`; `domains` scores up to 1,000 sites at once (`estimate` first) |
| Get links | `seo_backlinks_get` (free; `check` before working any site), `seo_link_sources_get`; submitting is the `link-submissions` skill; more places from the live web: the `find-link-sources` skill; pitching sites by email: the `link-outreach` skill |
| Rank on big sites with posts | `seo_parasite_get` view `chances` (free); writing one is the `parasite-post` skill |
| Local results, Maps, reviews | `seo_local_get` (`estimate` first) |
| One keyword's figures, ideas or Google results | `seo_keyword_metrics_get`, `seo_keyword_ideas_get` with `seeds`, `seo_serp_get` with `depth: 10` or a `type` (AI Overview, AI Mode, Maps) (priced first) |
| A keyword's history, forecast, top 10 strength | `seo_keyword_lookup_get` (`estimate` first) |
| A report (site review, rankings, AI visibility, keywords, a check-in to share) | the `seo-report` skill; saved ones: `seo_reports_get` |

No fit: `skills_list` and pick by description; with no skill, use the page's tools below, free
reads first.

## The order of the work

1. **Project and profile**: what the site sells, to whom, its markets and competitors.
2. **Keyword research**, ending with the **main keyword**, the home page of the plan.
3. **AI visibility**: the searches AI assistants run for the site's buyers become keywords.
4. **Content planner**: the targeted keywords become a map of pages, their order and links.
5. **Content writer**: page by page, edited where the page lives and scored against Google's top
   pages until it passes.
6. **Keep it healthy**: Do next, audit issues and internal links go to `fix-my-site`; pages that
   lose clicks go back to the writer.

Steps 2 to 4 are the SEO plan (`seo_plan_get`); a redo marks the later steps stale.

**Publish only finished work.** Google judges a new site, and each new page, early, and a weak first
verdict can take a long time to undo. When the user wants to put thin, unfinished or unscored pages
live to "fix later", say so in one line and recommend finishing them first (the writer's score
passing). Keep pages that matter current: a meaningful update counts, a cosmetic one does not.

## What runs on its own

- The crawler re-reads the site (traffic pages daily, the rest weekly); `seo_site_audit_crawl` asks
  for one now.
- Search Console and Analytics sync daily; `seo_search_console_sync` makes keyword research wait for
  fresh data.
- Written and live plan pages are followed in Rank tracking (free: Search Console) and scored (charged to the balance).
- Internal links and the Do next list are recomputed after every crawl or map change.

## The app's pages and their tools

- **Dashboard** (Do next, Performance, Changes, Indexing, Page speed, a page's panel). Read:
  `seo_overview_get` (every area at once), `seo_actions_list`, `seo_dashboard_get`,
  `search_performance_get` (`strikingDistance`: quick wins), `seo_pages_get`, `seo_indexing_get`,
  `seo_site_health_get`, `web_analytics_get`. Change:
  `seo_actions_update` (done, snooze, dismiss), `seo_page_notes_add`, `seo_page_changes_record`
  (record a change made in the site's files, or `undo` one), `seo_dashboard_update` (saved views,
  headline tiles, brand terms), `seo_indexnow_update`.
- **Keywords** (main keyword, focus, table, lists). Read: `seo_keywords_list`,
  `seo_keyword_lists_list`, `seo_keyword_lists_get`. Change: `seo_keywords_update`,
  `seo_keywords_save`, `seo_keyword_lists_create`, `seo_keyword_lists_update`,
  `seo_keyword_lists_delete`, `seo_research_log_append`. Paid: `seo_keyword_ideas_get`,
  `seo_keyword_metrics_get`, `seo_competitor_keywords_get`, `seo_serp_get`.
- **AI visibility** (mentions by assistant, "Questions people ask"). Read:
  `seo_ai_visibility_get`. Change: `seo_ai_visibility_run` (paid), `seo_ai_visibility_update`.
- **Content planner** and **Internal links**. Read: `seo_content_plan_get`. Change:
  `seo_content_plan_build`, `seo_content_plan_update`; links are applied by `fix-my-site`.
- **Content writer**. Read: `seo_content_writer_get`, `seo_content_score_get` (saves the page's score). Change:
  `seo_content_writer_build`, `seo_content_writer_update`.
- **Other sites** (posts on big sites). Read: `seo_parasite_get`. Change: `seo_parasite_update`,
  `seo_parasite_build` (paid parts priced first).
- **Site audit**. Read: `seo_site_audit_get` (`view: "shares"`, `view: "sitemap"`),
  `seo_site_audit_inspect`. Change: `seo_site_audit_crawl`, `seo_site_audit_update` (`share`
  makes a public report link, shown once; `unshare` revokes it).
- **Rank tracking**. Read: `seo_rank_tracking_get` (paged with `nextOffset`; the site's positions
  come from Search Console, free; guest posts are checked and charged). Change: `seo_rank_tracking_update`.
- **Site explorer**. Read: `seo_site_explorer_get`.
- **Keyword lookup**. Read: `seo_keyword_metrics_get`, `seo_keyword_ideas_get`, `seo_serp_get`,
  `seo_keyword_lookup_get`. Change: `seo_keywords_save`, `seo_keyword_lists_update`,
  `seo_rank_tracking_update`.
- **Backlinks**. Read: `seo_backlinks_get`, `seo_link_sources_get`. Change:
  `seo_backlinks_update`, `seo_link_sources_update` (`match` priced first).
- **Reports**. Read: `seo_reports_get` (`templates: true`). Change: `seo_reports_update`.
- **Integrations**. Read: `integrations_list`, `seo_wordpress_get`, `seo_data_source_update`. Change:
  `seo_wordpress_update` (writes to the connected site).
- **No page**: `seo_local_get`; the plan's pair `seo_plan_get` and `seo_plan_step_confirm`.

## What only the app can do

Connecting an integration, adding to the balance or changing the plan, saving the user's own AI
keys, and creating API keys. Choosing which property a project uses from an account already
connected is yours: `projects_sources_list`, then `projects_sources_update`. For the rest, say so in
one line with the link a tool gave (`connectUrl` from `integrations_list`, `billingUrl` from
`account_status_get`, `listUrl`), then go on with what you can do.
