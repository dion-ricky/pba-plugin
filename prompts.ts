// Role prompts and prompt builders for the PBA loop.
//
// The three agents (pba-planner / pba-builder / pba-auditor) are defined as
// markdown agents in `.opencode/agents/`; their markdown body is the *role*
// system prompt. What this module builds is the *per-loop task prompt* the
// orchestrator sends when it spawns each phase session.

import type { PbaState } from "./state"

export const AGENT_BY_ROLE = {
  plan: "pba-planner",
  build: "pba-builder",
  audit: "pba-auditor",
} as const

export function plannerPrompt(state: PbaState, loopDir: string): string {
  const revisionBlock = state.revision
    ? `
## Revision required (attempt ${state.attempt}/${state.maxAttempts})

The auditor disapproved the previous build. Read ${loopDir}/review.md first:
it contains the audit report and numbered findings. Address EVERY finding in
your revised plan. Keep what already works; change only what the findings
require, unless your analysis shows a finding is based on a misunderstanding
(in that case, say so explicitly in the plan's "Notes" section).
`
    : ""

  return `You are the PLANNER phase of PBA loop \`${state.loopId}\` (attempt ${state.attempt}/${state.maxAttempts}).
Loop directory: ${loopDir}
${revisionBlock}
## Task spec (from the user)

"""
${state.spec}
"""

## Your procedure

1. Call the \`pba_state_read\` tool (no arguments) to load the current loop state.
2. Investigate the codebase as needed to ground the plan in reality (you are read-only).
3. Write a complete, actionable plan and submit it with the \`pba_plan_submit\` tool:
   - \`plan\`: the full plan in markdown. Include: goal, non-goals, proposed file changes
     (paths + what changes), task breakdown in implementation order, risks/assumptions,
     and how each item of "acceptance criteria" will be verified.
   - \`summary\`: one-sentence summary.
   - \`tasks\`: ordered list of concrete implementation tasks.
   - \`acceptanceCriteria\`: checklist the auditor will use to approve or reject the build.

Calling \`pba_plan_submit\` is MANDATORY and is how you finish this phase.
Do not implement anything. Do not create or edit files outside the loop directory.`
}

export function builderPrompt(state: PbaState, loopDir: string): string {
  return `You are the BUILDER phase of PBA loop \`${state.loopId}\` (attempt ${state.attempt}/${state.maxAttempts}).
Loop directory: ${loopDir}

## Your procedure

1. Call the \`pba_state_read\` tool (no arguments) to load the current loop state.
2. Read the plan at ${loopDir}/plan.md and implement it exactly${state.revision ? ", incorporating the fixes for the audit findings (see state and review.md)" : ""}.
3. Keep the change minimal and focused on the plan. Do NOT commit to git.
4. When implementation is complete, call the \`pba_build_complete\` tool with:
   - \`summary\`: what you implemented and any deviations from the plan (with reasons).
   - \`changedFiles\`: list of files you created or modified.
   - \`notes\`: optional context for the auditor.

Calling \`pba_build_complete\` is MANDATORY and is how you finish this phase.`
}

export function auditorPrompt(state: PbaState, loopDir: string): string {
  const changed = state.changedFiles.length > 0 ? state.changedFiles.join(", ") : "see state"
  return `You are the AUDITOR phase of PBA loop \`${state.loopId}\` (attempt ${state.attempt}/${state.maxAttempts}).
Loop directory: ${loopDir}

## Your procedure

1. Call the \`pba_state_read\` tool (no arguments) to load the current loop state.
2. Read the plan at ${loopDir}/plan.md.
3. Review what the builder produced. Reported changed files: ${changed}.
   - Inspect the working-tree diff: \`git diff\` for tracked files and read untracked
     files listed in the state.
   - Verify every task in the plan was implemented and every acceptance criterion is met.
4. You may run cheap read-only checks (tests, linters, typechecks) if the repo has them.
5. Do NOT modify any files. You are read-only.
6. Submit your decision with the \`pba_verdict\` tool:
   - \`verdict\`: "approved" or "disapproved".
   - \`report\`: full audit report in markdown (what you checked, what passed, what failed).
   - \`findings\`: numbered, specific, actionable issues. REQUIRED and non-empty when
     disapproved; each finding should reference the plan task or acceptance criterion it
     violates. Empty array when approved.

Be strict: disapprove if any acceptance criterion is unmet or the change deviates from
the plan without justification. Calling \`pba_verdict\` is MANDATORY and is how you
finish this phase.`
}

export const SKILL_CONTENT = `# PBA loop (plan-build-audit)

Run a supervised implementation loop for non-trivial changes: a planner writes a
plan, a builder implements it, and an auditor reviews the result. The auditor
can send work back to the planner for revision; the loop continues until the
build is approved or the attempt budget is exhausted.

## When to use

- The user explicitly asks to "run the PBA loop" or wants a planned, built, and
  independently audited change.
- The change is multi-file or risky enough to benefit from a plan and an audit.

## How to run it

1. Call the \`pba_start\` tool with:
   - \`spec\`: the full task description (copy the user's request; expand or
     clarify if the user gave you a spec/proposal file, and note the source).
   - \`title\` (optional): short name for the loop; used in the loop ID.
2. The tool returns a \`loopId\` immediately. The loop then runs in the
   background and posts progress and the final verdict summary as messages in
   this session.
3. Do NOT try to run planner/builder/auditor yourself via the subagent tool,
   and do not implement the change while a PBA loop for the same spec is
   active — the loop handles it.

## Checking on it

- Use the \`pba_status\` tool (optionally with a \`loopId\`), or tell the user
  to run \`/pba-status\`.
- To resume a loop that was interrupted (e.g. OpenCode restarted mid-loop):
  \`/pba-resume <loopId>\`.

The loop writes its coordination state under \`.pba/<loopId>/\` in the repo
(state.json, plan.md, review.md, events.jsonl).
`
