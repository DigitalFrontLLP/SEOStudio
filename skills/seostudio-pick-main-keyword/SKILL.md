---
name: seostudio-pick-main-keyword
description: "SEOStudio: Help the user pick the one main keyword their site should rank for, from the keywords they target, recommending the highest-priority buyer search that names the whole offer, with its buyer facts (CPC, what the first page sells, offer and choosing answers, volume) as the reasons. Use after keyword research, or when the user asks which keyword to go after first."
metadata:
  title: Pick main keyword
  summary: Choose the one main keyword your site should rank for first
  inputs:
    - name: project
      title: Project
      description: Your site's domain (e.g. example.com), or the project's id or exact name. Left out, your only project is used, or you are asked which one.
      required: true
    - name: market
      title: Country
      description: ISO 3166-1 country code, e.g. US. Taken from the project's own market, or from the active list, when omitted.
      required: false
    - name: language
      title: Language
      description: ISO 639-1 language code, e.g. en. A region tag such as pt-BR is accepted and read as pt. Taken from the active list when omitted.
      required: false
---

# Pick main keyword

This is a mandatory procedure: follow every step in order; add no steps of your own; ask the user where it says to ask.

## Goal

Exactly one keyword ends in the `main` state for the project's market and language, picked BY THE
USER from a short list you recommend. The main keyword names the WHOLE offer (the other targeted
keywords read as branches of it) and stands highest in priority. Volume alone never decides.

## How you talk to the user

- Ask every question with your question tool (`ask_user`, or your runtime's own), one at a time,
  the recommended answer first. Never end on a question written in prose.
- When you must stop, say in one line what is missing, then ask for it.
- Be short: one line before you spend, never a restatement of what a tool returned.
- Money is said in dollars from the tools' own figures: `~$0.40` before a call, the exact cost
  after. A figure a tool calls "up to" stays "up to". The user's money is their balance, never "credits".

## Rules

- **Market and language.** The tools have NO default market or language. Take both from
  `projects_get`. Only when `market` is null, ask once and save it with `projects_update`. A pick is
  for ONE market; name the project's other `markets` once at the end.
- **Cost.** Everything is free except a fresh `seo_serp_get` (its description gives the price; results
  under 7 days old are free).
- **A paid call that refuses bought nothing.** No balance: stop pulling and judge on what you have. Provider refused:
  do not retry. Provider unreachable: retry once.
- **Never recommend** a candidate with `eligible: false`.
- **The gate: it names the whole offer.** Skip a candidate that names one branch (one feature, one
  place, one integration), another company's product, a free tool or a competitor's brand, however
  high its priority.
- **Write the research log before you stop**, whatever stopped the run.

## The candidates

`seo_keywords_list` with `mainCandidates: true` answers the targeted keywords in recommendation
order, one per search (the spellings of one search are one candidate):

- `eligible`: the search is surely about what the business sells, its searcher is choosing, and it
  names no listed competitor. Eligible ones come first, by `priority`.
- `reasons`: the facts you show (cost per click, what the first page sells in `serpPages`, the offer
  and choosing answers, searches a month, difficulty). They explain the priority; they never
  overrule it.
- `ranks`: where the site already ranks for it (`position`, `url`), or null. Show it; it never
  changes the order.

Recommend the highest-priority eligible candidate that names the whole offer.

## Steps

**Inside keyword research** (its step 17), start at step 2 and ask only the step 5 question: no
table and no other question, the research's report lines on top, each option a candidate with where
the site ranks and its `Why`, and "Keep <current keyword>" as an option when a main keyword exists.
On its own, run every step.

1. **Read the project.** `projects_get`, `account_status_get`, and `seo_plan_get`:
   - `blocked.reason` `no_profile`: run the `project-profile` skill now without asking (`skill_get`), then
     check the plan again. `no_website`: ask for the address and set it with `projects_update`.
   - The `main_keyword` step `done`: read its `redoWarning` and get a yes. `stale`: offer "Pick
     again" / "It still stands"; on the second, `seo_plan_step_confirm` and stop.
2. **Read the candidates.** `seo_keywords_list` with `mainCandidates: true`, the market, the
   language and `limit: 25`. `scored` is 0: stop, keyword research comes first. A main keyword
   already set: say which and ask whether to replace it.
3. **Shortlist three to five**, in the answer's order, eligible and past the gate. Fewer than three:
   read again with a higher `limit` (at most 500).
4. **Read each one's first page.** `seo_serp_get` per candidate (usually cached). Check that the pages
   that sell or compare sell what this business sells.
5. **Ask the user to pick.** ONE short table, then the question, your recommendation first:

   | Priority | Keyword | Searches | CPC | First page | Offer | KD | You rank | Why |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- |

   `Why` is five words at most; `You rank` is the position and page path, or "-". Each option names
   where the site ranks for it. The question adds ONE line on the fact that puts your
   recommendation above the runner-up. Set nothing before the user answers.
6. **Set the state.** `seo_keywords_update` with `state: "main"`, the market, the language, the
   chosen keyword and a `reason` naming the evidence. It demotes the previous main keyword itself.
7. **Write the research log.** `seo_research_log_append` with `kind: "seo.pick-main-keyword"`, the
   cost, and a summary: the pair, the candidates with their priorities, the pick, whether it matched
   your recommendation, and the keyword it replaced.

## Finish

Two short lines, then ONE question:

1. The main keyword, plus `replaces "<old keyword>"` when it replaced one.
2. The one fact that settled it.

Then ask the next action from a fresh `seo_plan_get`: "<`nextAction` title> now" / "Later". A step
not built yet is said in one line, not offered; `nextAction: null` is said in one line with nothing
asked. After the answer, never repeat the result.

Everything this skill writes stays inside this app. Never publish or change anything outside this
app unless the user asked for that specific change.
