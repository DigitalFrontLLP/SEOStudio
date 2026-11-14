---
name: seostudio-keyword-research
description: "SEOStudio: Find every keyword a site could use, price them, read their Google results, ask the user about their focus (funnel level and topics), remove what clearly does not fit it, then pick the main keyword with the user. Use when a project has no keyword list yet, or when the user asks to widen or redo their keyword research."
metadata:
  title: Find keywords
  summary: Find, price and pick the keywords your site should target
  inputs:
    - name: project
      title: Project
      description: Your site's domain (e.g. example.com), or the project's id or exact name. Left out, your only project is used, or you are asked which one.
      required: true
    - name: market
      title: Country
      description: ISO 3166-1 country code, e.g. US. Taken from the project's own market when omitted.
      required: false
    - name: language
      title: Language
      description: ISO 639-1 language code, e.g. en. A region tag such as pt-BR is accepted and read as pt. Derived from the project's language when omitted.
      required: false
    - name: seedTopics
      title: Topics
      description: Extra topics to start from. Left out, you are asked about your focus during the run.
      required: false
---

# Keyword research

This is a mandatory procedure: follow every step in order; add no steps of your own; ask the user where it says to ask.

## Goal

Collect every keyword the site could use, price them and read their Google results. The model answers
a few yes/no questions per keyword. The code leaves out only what the model is sure is out; EVERY OTHER
KEYWORD IS TARGETED. You ask the user the focus, then remove only what clearly does not fit it. The
run ends by picking the main keyword with the user.

## Rules for the whole run

- **Ask through the question tool** your runtime offers (`ask_user`, or your own), the recommended
  answer first. Never put a question in prose and stop.
- **Be short.** Before you spend, say what you will do and what it costs in one line. Say nothing
  between repeated calls. Never restate what a tool returned.
- **Every price and balance is money.** A cost figure a tool answers (`credits`, `costCredits`,
  `run.expected` and the like) is said in dollars, `$0.40`, and the user's money is their balance,
  never credits; when a tool's note already words the price, use its words.
  A price said before anything is spent is an estimate: write it `~$0.40`, never "about"; what
  was charged, and a maximum a tool calls "up to", stay as they are.
- **`complete: false` or `running: true`: call the same tool again with the SAME arguments.** Nothing
  is bought twice.
- **A paid call that refuses** bought nothing. Not enough balance: say the price and the balance.
  The provider refused: do not retry. Could not be reached: retry once. Not configured: stop.
- **An answer that says `stopped`** ends the run: say the line, ask "Retry" / "Stop".
- **Write the research log before you stop**, whatever stopped the run.
- **You only remove.** Your review never targets a keyword. Never move a row the user moved
  (`m: "user"`).
- **A redo the user already confirmed is never asked again.** When the request says the user
  confirmed it on the page, skip every "redo this?" question (the step's `redoWarning`, "Start
  over") and go on as on a yes. Still ask what only the user can answer (the focus).
- The tools have NO default market or language. Use the same pair in every call of the run.
- **Web research:** follow the `web_search` description: your runtime's own TinyFish search and fetch tools when it has them, else the app's `web_search` and `web_extract`.

## Tools and costs

| Tool | Cost |
| --- | --- |
| `projects_list`, `projects_get`, `projects_update`, `account_status_get`, `seo_plan_get`, `skill_get`, `seo_plan_step_confirm`, `seo_search_console_sync`, `search_performance_get` | free |
| `seo_keywords_list` | free; `review: true` reads the targeted pool, 100 short rows a page; with `brief: true` keywords only, 1,000 a page |
| `seo_competitor_keywords_get` | paid per page of 1,000 rows fresh, free from cache. One call buys at most 10 pages |
| `seo_keyword_ideas_get` | paid per request plus a share per row, fresh; free from cache. `estimate: true` prices it and buys nothing |
| `seo_keyword_metrics_get` | paid per keyword bought (one request carries up to 700); held numbers are free. Keywords with no figure are asked of Google Ads, per batch of 1,000. Never pass `clickstream` unless the user asks |
| `seo_keywords_save` | free; `evaluate: true` buys only the facts the keywords miss |
| `seo_serp_get` with `saved: true` | per keyword not judged yet: a fresh first page (free from cache) plus a small reserve for judging it and the keyword questions (usually settles lower) |
| `seo_keywords_update` | `state: "apply"` with new topics buys each keyword's topic answer; inside the run it collects the related searches of the targeted keywords' Google results, priced at the `seo_keyword_metrics_get` price and checked at the `seo_serp_get` price; it labels the Google results of the keywords the rules keep, and ranks; with `estimate: true` and topic `examples` it buys only the test answers not held yet; `state: "check"` and targeting named keywords buy what they miss (`estimate: true` prices it); removing is free |
| `seo_research_log_append` | free; it also ranks the targeted keywords, buying any priority answers they miss |

Prices depend on the account's plan: quote only the price a tool's description, its `estimate` or
its answer states, never a figure from memory. Every paid tool returns what it cost. Add those
numbers; do not guess.

## Steps

1. **Read the project.** `projects_get`. Take `market` and `language` from it. Only when `market` is
   null, ask the user (the country the site's language points at first) and save it with
   `projects_update { project, market: "XX" }`. A run is ONE market: name the project's other
   `markets` once at the end. Never change `market` on your own.
2. **Check the plan.** `seo_plan_get`. If `blocked.reason` is `no_profile`, run the `project-profile` skill
   now, without asking (`skill_get`, then follow it), and check the plan again. If `blocked.reason` is
   `no_website`, ask the user for the site's address and set it with `projects_update` (`url`). If the `keyword_research`
   step is `done` or `stale`, read its `redoWarning` out and get a yes, unless the user already
   confirmed the redo on the page. If `profileChanged` is set,
   say its `note` in one line.
3. **Sync Search Console.** `seo_search_console_sync` until `ready: true`. On `failed` or `stalled`:
   say the `error`, ask "Retry the sync" / "Stop", retry with `retry: true`. When the `error` says the
   connection must be authorized again, a retry cannot help: say to reconnect Search Console on the
   Integrations page, and stop. With `rows: 0`, say in one line that the site has no Search Console
   data yet, and go on. With `state: "none"` (not connected), say in one line that connecting Search
   Console on the Integrations page adds the searches the site already appears for, and go on
   without it: skip step 5, and the research runs from the site, its profile, the competitors and
   the keyword data.
4. **Estimate the cost.** `account_status_get` for the balance. `seo_keyword_ideas_get` with the market,
   the language, `collect: true` and `estimate: true`. Its `run` is the whole run's estimate: say it in
   one line, likely figure first ("~$`run.expected`, up to ~$`run.max`"), never as a bare
   range. If the balance cannot cover `run.max`, say both numbers. When the run stops at its
   maximum, say the new total in one line and carry on as the tool's answer says.
5. **Quick wins.** `search_performance_get` with `strikingDistance: true` and `country` set to the
   run's market. Name them as the quickest wins. Do not save them: step 9 saves every Search Console
   query.
6. **Competitors.** `seo_competitor_keywords_get` once per competitor the project lists, every one of
   them. It saves their keywords itself. A pull that stopped is continued with `refresh: true`. No
   competitor listed: say so and go on. Never invent a domain. The research uses only the listed
   competitors and never looks for new ones: the project profile finds them.
7. **Your own ideas**, in the site's language, only in these shapes, where they fit the business:
   - for EVERY listed competitor, written in the site's language (no tool adds these for you):
     `<competitor> alternatives`, `<competitor> pricing`, `<competitor> review`, `<competitor>
     reviews`, `<competitor> promo code`, `<competitor> coupon`, `<competitor> discount code`,
     `<competitor> legit`, `is <competitor> legit`, `is <competitor> safe`, and
     `<competitor> vs <competitor>`
   - `best <product> for <audience>`
   - `<product> for <industry>`, and `<product> for <platform>` for every platform it ships on
   - `<platform> <product>` for every platform it ships on, and `<part> <product>` for every part,
     provider or material it is built with, each in the words buyers use for the product
   - `<product> <integration> integration`
   - the parts, providers or materials it is built with or lets the customer choose, and the main
     alternatives for each of those parts, WITHOUT the product word: `<part> vs <alternative>`,
     `<part> pricing` (never the market price of a currency or commodity), `is <part> free`,
     `best <kind of part> for <platform>`
   - every standard document template, policy and calculator its customers need for the business
     or the work they run with what it sells, each by its plain name WITHOUT the field word:
     `<document> template`, `<policy> template`, `<metric> calculator`
   - a few `<topic> statistics` (they earn links)
   - `<service> in <city>`, only for a local business
   - the user's `seedTopics` in the same shapes

   No "what is" or "how to" searches.
8. **Save your ideas.** `seo_keywords_save` with your ideas, source `ai`. Write every idea yourself,
   straight into the tool calls: never a shell command, a script or a file to write, generate or
   assemble them. A long list may be saved in several `seo_keywords_save` calls, each with a part of
   it; step 9 passes the whole list in one call.
9. **Collect.** `seo_keyword_ideas_get` with the market, the language, `collect: true` and `ideas` set to
   your ideas. Repeat while `complete` is false. If it refuses, do what the refusal says, then call
   it again. It answers `unpriced`.
10. **Price.** `seo_keyword_metrics_get` ONCE with `keywords` set to `unpriced`, the market and the
    language. The code removes every keyword with no search volume; drop nothing yourself.
11. **Read Google results.** `seo_serp_get` with `saved: true`, the market and the language, nothing
    else. Repeat while `complete` is false. It reads every first page and asks each keyword whether
    the searcher is choosing something, whether it is about this kind of offer or another platform or
    place, and whether it is a support or piracy search. A search that is exactly a listed
    competitor's name or domain and nothing else is always left out as that competitor's brand
    search. A search naming a listed competitor with other words is left out as its brand search
    when its other words ask for the competitor itself and Google's first result is the
    competitor's own page. It does not collect the related searches the pages show yet: step 14
    does, from the targeted keywords only.
12. **Name the topics.** `seo_keywords_list` with `review: true`, `brief: true`, the market and the
    language, then again with `offset` set to `nextOffset` until it is null. From this scan, name 3
    to 6 topics (1 to 6 when the scan is small), one line each, never overlapping:
    - `offer`: the business's own kind of product or service, for its own platform and place. What
      it gives away (free items, a code) belongs here, and so do a local business's `near me` and
      `<service> in <city>` searches.
    - `field`: the choices the business's customers make around its product: which provider, tool or
      material to pick for each part the product is built with or lets them choose (the platform it
      runs on and what the business itself sells are not parts, nor are ways to pay such as payment
      methods, vouchers, cards or currencies unless the business sells or builds them), and how they
      compare (`<part> vs <alternative>`, `<part> pricing`, `best <kind of part> for <platform>`).
      Its definition names those kinds of parts; every provider of one of them belongs, whether the
      profile names it or not, when its searches are about the business's own platform, game or
      market. Not: this kind of product built on a provider the business does not use, and kinds of
      parts the product does not have (any provider of a kind it has stays).
      Comparisons of the platform, frameworks and libraries the product is built on with others
      (`<its platform> vs <another>`, `<its library> vs <another>`) are a field topic of their own.
    - `link_magnet`: statistics, data, free tools and templates of the business's own field, for its
      own platform, game or place, whenever the pool has them. A general tool of a wider field is not
      one. Its definition names only the documents and calculators specific to that field, the ones its
      customers need because they run this kind of business; a general document every kind of business
      uses (a roadmap, a business plan, a requirements document) or one written for another kind of
      business stays out of the definition.
    - `place`: only for a local or travel business, searches about the place it serves itself (what
      to do there, its weather, its neighbourhoods, the local conditions that bear on the service).
    - Never a topic for another product line, game, platform or place, or for something the site
      only mentions in passing.
    - Every definition is scoped to what the business itself serves (its own products, platforms,
      games, markets or categories, and the parts its customers choose with it):
      `<the business's product> value tools`, never `value tools` or `<another product> value tools`.
      Tools, data and products for another product, platform or market, and general ones spanning
      many, are out of every topic.
    - Name each topic in the customer's plain words, the way they would say it, never a label
      invented for a group ("<kind of part> compared", not "<field> stack providers"), in the language
      the user writes to you in, and note 2 to 3 searches from the scan that show it, as they are.

    Mark as recommended the offer topics, the link-magnet topic, the field topic comparing the
    platform, frameworks and libraries the product is built on, and each field topic whose parts the
    customer picks while buying or using the product; a field topic that is general research about
    the field, away from hiring or buying from the business, is shown but not recommended. So is a
    field topic whose searches are about buying or selling the parts themselves from a different
    kind of business (`buy <part>`, `<part> for sale`, `cheap <part>`, from a shop or marketplace
    that sells them): it is offered but not recommended. A place
    topic is shown, never recommended.

    Test each topic: pick 5 searches from the scan that belong in it and 5 near ones that do not (1
    to 5 a side when the scan has fewer; never invent one). When the scan has them, the near ones
    include the same kind of search for another product or market, or a general one spanning many.
    Call `seo_keywords_update` with `state: "apply"`, `estimate: true` and each topic's
    `examples: {in, out}`. A topic with `pass: false` gets a sharper definition: its `inScoredOut`
    are `in` searches the definition missed, so say what they are about in it; its `outScoredIn` are
    `out` searches it took in, so name what they are about in `Not:`. Test it again, at most twice.
13. **Ask the focus.** Ask two questions together, in one call when your tool takes several
    (otherwise one after the other). Keep the question text short: no list of topics, no symbols,
    no explanation block. Write the questions, the topic names and the option labels in the
    language the user writes to you in; the example searches stay as they are.
    1. "Which topics should your keyword list cover?" (several answers): one option per topic, the
       recommended ones first, each label the topic name with "(Recommended)" after the recommended
       ones, each option's description its 2 to 3 example searches.
    2. "Which searchers should it target?": "Ready to choose or buy (Recommended)" (`bottom`; best
       X, X vs Y, alternatives, pricing, reviews and deals are always included) / "Ready to buy and
       still comparing" (`middle`) / "Everyone, including people just learning" (`full`).

    If no user can answer, take the recommended topics and `bottom`.
14. **Apply the focus.** `seo_keywords_update` with `state: "apply"`, the market, the language and
    `focus: { funnel, topics }`. Pass EVERY topic with `name`, `definition`, `kind`, `picked` and
    `recommended`. It also collects the related searches and "people also ask" questions of the
    targeted keywords' Google results and checks them, so the ones that fit the focus are targeted
    before your review, and labels the page types of every targeted keyword's Google results, which
    your review reads. The estimate of step 4 covers what it buys. While `remaining` is above 0
    (`complete: false`), call it again with the same focus before anything else; nothing is bought
    twice.
15. **Review the targeted keywords.** `seo_keywords_list` with `review: true`, the market and the
    language, from `offset` 0 to the last page. Each row: `k` keyword, `v` searches a month, `kd`
    difficulty, `ch` choosing something, `o` about the offer, `ob` another platform or place (each
    `sure_yes`, `leaning_yes`, `leaning_no` or `sure_no`), `u` rules the model was unsure on: judge
    these rows with extra care, `tp` topic, `h` top 3 sites, `g` page types of the top ten, `pos` the site's position, `sp` spellings, `m` where it
    stands.

    Judge EVERY row yourself by reading it. Never a script, never word patterns. The answers are
    hints. The code never targets a search surely about a topic the user did not pick: it is not in
    this pool, and a target move for it is refused. Missing a good search is far worse than keeping a weak one: the topical map filters the
    weak ones later. Remove only what clearly does not fit the focus:
    - a product's own search: its name alone, its login, account, docs, support or download
    - docs and setup of a tool
    - another platform, framework, language, game or place than the business serves, and this kind
      of product built on or for another one (a version number is not another one)
    - this kind of product made of another material, when the business's description names what it
      sells by its material
    - this kind of product built with or for a provider, component or library the business neither
      uses nor offers as a choice (a search comparing that provider with another stays)
    - another meaning of the words, news, jobs
    - a search that names no game, platform, place or brand, when `h` shows sites about another one
    - a search outside the picked topics, or a search for the offer beyond the funnel level
    - the price, plan or comparison of a kind of part the business's product does not have

    Keep, even when a line above seems to fit:
    - a comparison of the platform the business runs on with another platform
    - a comparison of this kind of product, or the alternatives to one, even when it names a brand
      the business does not sell
    - every search that names a listed competitor with other words (its deals, codes, gift cards,
      reviews, whether it is legit or safe, alternatives, comparisons, pricing, its products or
      features), except its login, account, support or download: a competitor sells this kind of
      product, and every competitor the profile lists is one, whatever Google shows for its name
    - a place word on a tool, template or calculator search, for a business that sells online to
      any place
    - in a picked link-magnet topic: what its definition names (its definitions, formulas and how-tos
      only when the funnel is full)

    **When unsure, keep.**

    After each page, one `seo_keywords_update` call with `state: "dormant"`, `ownJudgement: true`,
    the removed `keywords`, a `reason` and a `keywordReason` of at most six words ("Another game's
    search", "Docs for a tool").
16. **Log.** `seo_research_log_append` with `kind: "seo.keyword-research"` and a summary: the pair,
    the sources and their counts, keywords saved, the focus, searches targeted and removed, and how
    many rows were unsure (`unsure` of the review) and how many of those you removed
    (`unsureRemoved`).
17. **Pick the main keyword.** Ask nothing before it and say nothing in chat. Read the
    `pick-main-keyword` skill with `skill_get` and follow its steps 2 to 7 with the same market and
    language (step 2 of this run did its step 1 checks). Its step 5 is the ONLY question: ONE question
    with the question tool, the recommended candidate first, each option a candidate with its `Why`.
    The question's text starts with the report of this run:
    - `N searches targeted for <funnel level>, <topics>, <MARKET>/<language>.`
    - `M more saved, not targeted.`
    - `Cost: $X.` (the `costCredits` the log answered)

    If something looks wrong, add your doubt as ONE short line. When a main keyword already exists,
    one option is "Keep <current keyword>": on it, set nothing, call `seo_plan_step_confirm` with
    `step: "main_keyword"` if that step is `stale`, and still write its step 7 log. If its step 2
    stops (nothing to pick), say the report lines and go to step 18.
18. **Next.** ONE question with the question tool from a fresh `seo_plan_get`: "<next step's title>
    now" / "Later". Its text is the main keyword line (and `replaces "<old keyword>"` when it replaced
    one), nothing else in chat. After the answer, never repeat the run's result (it is already on
    the questions): "<next step> now" starts that step's skill with no line before it; "Later" gets
    ONE short line naming where to start it (the step's page in the sidebar), and nothing else. The
    step is always `nextAction`, never one named from memory. When `nextAction` is null, every plan
    step is done: write the main keyword line and that in one more line, and ask nothing.

## When the user asks later

Use the same market and language. Each of these is the user's own request; never do them on your own.

- **Change the focus:** run step 11 (it buys only the answers still missing, usually none), ask the
  questions of step 13 again, apply as in step 14 (a changed focus clears your earlier removals),
  then review every row as in step 15.
- **"Is X a good keyword?"** `seo_keywords_save` with the keyword and `estimate: true`. Nothing is
  saved or bought. Say the verdict in one line.
- **"Add X":** `seo_keywords_save` with source `user` and `evaluate: true`. It asks the same
  questions under the saved focus. Say the estimate's price first when it is above 0.
- **"Find more keywords":** `seo_keyword_ideas_get` without `collect`, `estimate: true` first.
- **"Target these" / "leave these out":** `seo_keywords_update` with `state: "active"` or
  `"dormant"`, the `keywords` and a `reason`. For targeting, `estimate: true` first.
- **"Check the waiting keywords" / "Re-rank":** `seo_keywords_update` with `state: "check"` /
  `"rerank"`, `estimate: true` first.
- **"Start over":** `seo_keywords_update` with `state: "start_over"` and a `reason`. Data already
  bought stays, and `state: "restore"` brings the cleared research back for 30 days. When the request says the page already cleared the research, do not start over
  again: run the steps from the start.
- **A note on a keyword:** pass `note` with `keywords` only when the user asked. Read and honour the
  notes `seo_keywords_list` returns.
- **"Make it a report"** (to read, print or share): the `seo-report` skill (read it with `skill_get`).

Everything this skill writes stays inside this app. Never publish or change anything outside this
app unless the user asked for that specific change.
