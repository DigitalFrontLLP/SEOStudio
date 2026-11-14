---
name: seostudio-seo-plan
description: "SEOStudio: The entry point for SEO content work. Reads where a project stands in the four-step SEO plan, tells the user the one next action, and runs the step skill that does it. Use when the user asks what to do next on a site, mentions their SEO plan or keywords, or does not name a step themselves."
metadata:
  title: SEO plan
  summary: "Run your SEO plan step by step: the one next step, then the skill that does it"
  inputs:
    - name: project
      title: Project
      description: Your site's domain (e.g. example.com), or the project's id or exact name. Left out, your only project is used, or you are asked which one.
      required: true
---

# SEO plan

This is a mandatory procedure: follow every step in order; add no steps of your own; ask the user where it says to ask.

## Goal

The user knows where their site stands in the four-step plan and does ONE thing next. This skill
reads the plan, says it, and hands over to the step skill that does the work. It decides nothing
itself.

## How you talk to the user

- Ask every question with your question tool (`ask_user`, or your runtime's own), one at a time,
  the recommended answer first. Never end on a question written in prose.
- When you must stop, say in one line what is missing, then ask for it.
- Be short: a few lines of facts, never a restatement of what a tool returned.
- Money is said in dollars from the tools' own figures: `~$0.40` before a call, the exact cost
  after. A figure a tool calls "up to" stays "up to". The user's money is their balance, never "credits".

## The four steps

What each step does, for the user who does not know it yet (once per conversation, in your own
plain words):

1. **Keyword research**: we find everything people search for that your site could answer.
2. **Main keyword**: we pick the one search your site should be known for.
3. **AI visibility**: AI assistants search the web too. We find the searches they run for your
   buyers, so your pages get cited.
4. **Content planner**: we turn your searches into pages grouped in silos, with what to write first
   and how to link them.

## Steps

1. **Read the plan.** `seo_plan_get` (free). When the user's reference fits more than one project,
   `projects_list` and ask which.
2. **Clear the block first.** `blocked.reason` says why the plan cannot start:
   - `no_profile`: run the `project-profile` skill now without asking (read it with `skill_get`),
     then read the plan again.
   - `no_website`: ask for the site's address and set it with `projects_update` (`url`).
   - Run nothing else until the block clears. A missing Search Console never blocks: when
     `gate.searchConsole` is false, say in one line that connecting it adds the searches the site
     already shows for.
3. **Say where the project stands.** ONE short line per step: its `title`, its `status` (and
   `summary` when it has one), plus what it does when the user does not know yet. Never a second
   list. Then offer `nextAction` in one line, without repeating what its step does.
   `nextAction: null` means every available step is done: say so and stop.
4. **A stale step** may or may not still hold. Offer both: redo it, or, when the user says it still
   stands, `seo_plan_step_confirm` with its `id` (free, deletes nothing). Never confirm on your own
   judgement.
5. **Before redoing a `done` or `stale` step,** read its `redoWarning` to the user and get a yes.
   No yes, no run.
6. **Run the step.** Read the step's `skill` with `skill_get` and follow it. A step with
   `available: false` is not built: say so and stop. Never improvise a step from single tools.

## Rules

- Never write plan state. Each step completes inside the tool that did its work; the only write
  here is a confirmation the user asked for.
- This skill spends nothing; the step skill prices its own calls.
- The tools have NO default market or language: the step skill takes both from the project.
- Everything this flow writes stays inside this app. Never publish or change anything outside this
  app unless the user asked for that specific change, and when in doubt, ask first.

## Finish

At most two short lines, then ONE question:

1. What the step concluded, in one line.
2. Where the project stands now, in one line.

Then ask the next action from a fresh `seo_plan_get` with the question tool: "<title> now" /
"Later". `nextAction: null`: say every step is done and ask nothing.
