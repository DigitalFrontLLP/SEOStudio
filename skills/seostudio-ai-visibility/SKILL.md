---
name: seostudio-ai-visibility
description: "SEOStudio: Ask AI assistants (ChatGPT, Gemini, Google AI Mode, Google AI Overviews) the questions a buyer asks, report how often they cite, name and recommend the site next to its competitors, and save the searches they run on the web as keywords. Use when the plan's next step is AI visibility, when the user asks whether AI assistants mention their site, or to continue or check a run."
metadata:
  title: AI visibility
  summary: See how often AI assistants like ChatGPT mention and recommend your site
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
      description: ISO 639-1 language code, e.g. en. Derived from the project's language when omitted.
      required: false
---

# AI visibility

This is a mandatory procedure: follow every step in order; add no steps of your own; ask the user where it says to ask.

## Goal

Ask the AI assistants the questions a real buyer asks, then tell the user how often each one cites,
names and recommends their site next to its competitors. The searches the assistants ran to answer
are saved as keywords (the "AI searches" tab), so the user can write pages for them.

## How you talk to the user

- Ask every question with your question tool (`ask_user`, or your runtime's own), one at a time,
  the recommended answer first. Never end on a question written in prose.
- When you must stop, say in one line what is missing, then ask for it.
- Be short: two or three lines before you spend, nothing between repeated calls, never a
  restatement of what a tool returned.
- Money is said in dollars from the tools' own figures (`totalCredits`, `costCredits`,
  `recheckCredits`): `~$0.40` before a call, the exact cost after. A figure a tool calls "up to" stays "up to". The user's money is their
  balance, never "credits".
- **Times as the tools word them** (`finishedAgo`, `nextRunIn`): never a date or weekday you work
  out yourself.
- **Only this app's tools** and the web tools below. Never run a shell command or a script and
  never read a file: every number comes from a tool's answer. Too long to read: call again with a
  smaller `limit`.

## Rules

- **Market and language.** The tools have NO default market or language. Take both from
  `projects_get` (only when `market` is null, ask and save it with `projects_update`), and use the
  same pair in every call of the run.
- **Price first.** `seo_ai_visibility_run` with `estimate: true` is free and quotes exactly what
  the next call buys. Say the price before you buy, and stop when the balance cannot cover it. The
  run itself stops before it would charge past its quote.
- **Costs are the tools' own.** Every paid call returns what it cost: add those numbers, never
  guess. Never quote a re-check price from memory: it comes only from `schedule` or the update
  tool's answer. Only saved answers are charged (a search with no AI Overview counts nowhere,
  never as "not named").
- **A run the user asked for is never skipped.** However recent the last run, "run again" means run
  (or ask its one question).
- **A redo the user already confirmed on the page is never asked again.** Skip every "redo this?"
  question; still ask what only the user can answer.
- **Keep the prompt set stable** (see step 4), so trends stay comparable.
- **Answers from the run tool:**
  - `running`: the answers usually come in within a few minutes. Wait `checkAgainInSeconds`, then
    read `seo_ai_visibility_get` with `include: ["run"]` (free) until its `status` is `done`. Never
    follow a run with the run tool.
  - `checking`: wait `checkAgainInSeconds`, then call `checkWaiting: true` again; nothing is
    bought twice.
  - `paused`: say its `reason` and what is left in one line, then call again with
    `continue: true` to carry on.
  - `refused`: bought nothing. `insufficient_credits`: say the price and the balance. `blocked`: say why. `busy`:
    follow the run already working, or, while a scheduled re-check collects, run again once it is done. `invalid_input`: fix it once. `provider_failed`: do not retry.
    `misconfigured`: stop.
  - `checked` with `stopped`: say in one line that some AI searches still wait for a check.
- The run writes the research log itself: never append another line.
- **Web research:** follow the `web_search` description (your runtime's own TinyFish tools when it
  has them, else the app's `web_search` and `web_extract`).

## Steps

1. **Read the project.** `projects_get`; take `market` and `language` from it.
2. **Check the plan.** `seo_plan_get`. `blocked.reason` `no_profile`: run the `project-profile` skill now
   without asking (`skill_get`), then check again. `no_website`: ask for the address and set it with
   `projects_update`. `gate.searchConsole` false: say in one line that connecting Search Console
   adds the questions people already search for. The `ai_visibility` step `done` or `stale`: say
   its `redoWarning` in one line.
3. **Read what is there.** `seo_ai_visibility_get` with the pair.
   - A run with `trigger: "user"` that is `queued` or `running`: follow it (step 8). A scheduled
     re-check (`trigger: "schedule"`) finishes by itself: never call the run tool for it.
   - A run with `trigger: "user"` that is `paused` or `failed`: price the next call
     (`estimate: true`, no `prompts`), say the reason and the price in one line, then call the run
     tool without `prompts`, with `continue: true` (step 8).
   - `fanouts.waiting` above 0: price `checkWaiting: true`, say the price in one line, then call it
     until it answers `checked` (then go on only if the user asked for a new run).
4. **Decide what may change.** Read `review.status`:
   - `first_run` or `adopt_framework`: propose a whole set (step 5).
   - `review_due`: keep the set; replace at most `review.maxNew` prompts that perform worst or no
     longer fit.
   - `stable`: keep the set; only replace each prompt in `review.dead`, with one of the same
     category.
   The user's own prompts (`source: "user"`) are always kept.
5. **Write the set.** Sources: the active prompts, `search_console_prompts`, the top targeted
   keywords (`seo_keywords_list`, `state: "active"`, `sort: "priority"`, `limit: 25`), the profile
   and competitors, and after a first run the brands AI names most (`report`).

   Build a core set of 25 to 30 prompts, each with its `category`:

   | `category` | Count | What it asks |
   | --- | --- | --- |
   | `best_of` | 3-5 | the best options in the category, or for the main audience |
   | `use_case` | 6-8 | the best option for a job or a feature the site really serves |
   | `constraint` | 5-7 | the option that fits one buyer constraint (payment, cost, speed, region, offer) |
   | `trust` | 2-3 | which options are legit, or carry the proof buyers look for |
   | `alternatives` | 3-4 | alternatives to a competitor AI names most |
   | `head_to_head` | 2 | two most-named competitors compared |
   | `problem` | 0-2 | the option that solves a problem from Search Console questions |

   Then 2 or 3 `about_you` prompts that name the site itself (is it legit, a review). They, and the
   `alternatives` and `head_to_head` prompts (they name a competitor), are reported apart and never
   counted in the headline.

   Each prompt:
   - is a real question one buyer types to an AI assistant, in the project's language, 6 to 15
     words, in the buyer's words (never the site's own feature names);
   - asks ONE need with at most ONE qualifier (split "A and B" into two);
   - is answered well with 3 or more brands (no how-to or what-is questions);
   - asks only about what the site really offers;
   - names competitors only in `alternatives` and `head_to_head`, as people write them;
   - has no "right now", no source steering ("on <a forum>"), no role-play, no format instructions;
   - is not a near duplicate of another prompt.

   The run tool refuses a missing category, a year, the site's name outside `about_you`, too many
   brand-naming prompts and a change the stability rule does not allow (`set_is_fixed`): fix once,
   or drop it.
6. **Estimate.** `account_status_get`, then `seo_ai_visibility_run` with the pair,
   `estimate: true` and the WHOLE set in `prompts`, each with its `source` (`agent`,
   `search_console` or `user`) and `category`. Fix any `refused` prompt once and estimate again. The
   balance cannot cover the price: say both numbers and stop.
7. **Show the set**, nothing in the chat before it: the prompt count and the price on the first
   line, then the prompts grouped under short category lines, each prompt on its own `- ` line,
   shortened. End with a "Dropped:" list when prompts are retired. Then run them.
8. **Run.** `seo_ai_visibility_run` with the pair and the same `prompts`. While it answers
   `running`, wait `checkAgainInSeconds`, then read `seo_ai_visibility_get` with
   `include: ["run"]`. When the run is `done`, read `seo_ai_visibility_get` with
   `include: ["report", "crawlers"]`.

## Finish

ONE question, nothing else in the chat. Its text starts with:

1. `Named in X% of AI answers (N of M). Leader: <name>, Y%.` (`report`, scope `all`; no leader line
   when it is null)
2. `N AI searches added to your keywords, M targeted.`
3. `Cost: $X.`

Only when an engine in `crawlers.engines` has `blocked: true`, add one line naming the assistant,
the page and the robots.txt rule that blocks it. A `training` crawler is never the reason.

Then the next action from a fresh `seo_plan_get`: "<next step> now" / "Later". When `nextAction` is
null, offer re-checks instead, unless `schedule.frequency` is already `weekly` or `monthly` (then
ask nothing): add one line with the price per re-check and per month from `schedule`, and the
options "Weekly (Recommended)" / "Monthly" / "Not now".

After the answer, never repeat the result:

- "<next step> now": start that step's skill.
- "Weekly" or "Monthly": `seo_ai_visibility_update` with that `schedule`, then one line with
  `schedule.nextRunInDays` ("the next one in N days").
- "Later" or "Not now": write nothing.

## When the user asks later

Each of these is the user's own request; never do them on your own.

- **"Run again":** steps 1 to 4, then step 6 to price it. Then one message: `N prompts, ~$X.`,
  `The last run finished <finishedAgo>.`, the `redoWarning` when there is one, and the prompt lines
  only when the set changes. Then step 8, then Finish.
- **"Add / change / remove a prompt":** `seo_ai_visibility_update` with `add`, `edit` or `remove`.
  The user's own changes are always applied.
- **"Review my prompts":** step 4. Not due: say when it is (`review.reviewDueAt`, as "in N days").
- **"Check again every week / month":** `seo_ai_visibility_update` with `schedule` (`"off"` stops
  it); say the prices from its answer first.
- **"What did <an assistant> say about X?":** `seo_ai_visibility_get` with `include: ["answers"]`
  and the `promptId`. Quote at most two short lines.
- **"What do people ask AI about <keyword>?":** `seo_ai_visibility_run` with `research: { keyword }`
  (priced with `estimate: true`; free for 7 days once held).
- **"Make it a report"** (to read, print or share): the `seo-report` skill (read it with `skill_get`).

Everything this skill writes stays inside this app. Never publish or change anything outside this
app unless the user asked for that specific change.
