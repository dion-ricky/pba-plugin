// Role prompts and prompt builders for the PBA loop.
//
// The three agents (pba-planner / pba-builder / pba-auditor) are defined as
// markdown agents in `agents/` (mirrored inline in opencode.jsonc); their
// markdown body is the *role* system prompt. What this module builds is the
// *per-loop task prompt* the orchestrator sends when it spawns each phase
// session.

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

/** Default audit perspectives; overridable via options.auditPerspectives. */
export const DEFAULT_PERSPECTIVES = ["spec-adherence", "bugs", "security", "code-quality"] as const

/** Concrete review checklist per default audit perspective. */
export const PERSPECTIVE_GUIDANCE: Record<string, string> = {
  "spec-adherence":
    "You own full verification of every plan task and every acceptance criterion, one by one, with evidence. " +
    "A deviation from the plan is only acceptable if the builder justified it in the build summary.",
  bugs:
    "Focus on the correctness of the new/changed logic: edge cases, error handling, null/undefined handling, " +
    "race conditions, and broken or missing test coverage for the change.",
  security:
    "Focus on injection, committed secrets, unsafe subprocess/exec, permission/auth regressions, input validation, " +
    "and unsafe file paths. This repo spawns shell commands and writes files, so shell-quoting and path traversal are in scope.",
  "code-quality":
    "Focus on naming, duplication, dead code, type safety (tsc --noEmit), matching the surrounding style, and comment accuracy.",
}

export function auditorPrompt(state: PbaState, loopDir: string, perspective: string): string {
  const changed = state.changedFiles.length > 0 ? state.changedFiles.join(", ") : "see state"
  const guidance =
    PERSPECTIVE_GUIDANCE[perspective] ?? `Focus strictly on the "${perspective}" perspective.`
  return `You are the AUDITOR phase of PBA loop \`${state.loopId}\` (attempt ${state.attempt}/${state.maxAttempts}).
Loop directory: ${loopDir}

## Your assigned perspective: ${perspective}

${guidance}

You are one of several parallel auditors, each covering a different perspective. Review ONLY through your perspective's lens (plus the general procedure below).

## Your procedure

1. Call the \`pba_state_read\` tool (no arguments) to load the current loop state.
2. Read the plan at ${loopDir}/plan.md.
3. Review what the builder produced. Reported changed files: ${changed}.
   - Inspect the working-tree diff: \`git diff\` for tracked files and read untracked
     files listed in the state.
   - Verify every plan task and every acceptance criterion relevant to your perspective.
4. You may run cheap read-only checks (tests, linters, typechecks) if the repo has them.
5. Do NOT modify any files. You are read-only.
6. Submit your decision with the \`pba_verdict\` tool, passing \`perspective: "${perspective}"\`:
   - \`perspective\`: "${perspective}" (REQUIRED — identifies your report among the parallel auditors)
   - \`verdict\`: "approved" or "disapproved".
   - \`report\`: full audit report in markdown (what you checked, what passed, what failed).
     It is written to review-${perspective}.md.
   - \`findings\`: numbered, specific, actionable issues. REQUIRED and non-empty when
     disapproved; each finding should reference the plan task or acceptance criterion it
     violates. Empty array when approved.

## Strictness rules

- Verify, don't assume: for EVERY acceptance criterion and plan task relevant to your perspective,
  cite concrete evidence — file path + line references, or the output of a check you ran. An
  acceptance criterion you cannot verify with evidence is treated as UNMET.
- Disapprove if any acceptance criterion is unmet, any relevant plan task is missing, a deviation
  is unjustified, or your perspective finds any new problem introduced by the change. When genuinely
  uncertain after investigating, disapprove — a false disapproval costs one loop iteration; a false
  approval ships broken code to the user.
- Findings must be specific and actionable: file, what is wrong, and what the planner should change.
  Vague findings waste a whole loop iteration.
- Do not disapprove for style preferences that the plan did not require.

Calling \`pba_verdict\` with \`perspective: "${perspective}"\` is MANDATORY and is how you finish this phase.`
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

## Audit phase

The audit phase runs one auditor session per perspective (spec-adherence, bugs,
security, code-quality by default; configurable via \`auditPerspectives\`) in
parallel, each filing its own verdict with evidence. The orchestrator then
merges the perspective verdicts deterministically: approved only if every
perspective approves; otherwise the findings of all disapproving perspectives
go back to the planner.
`
