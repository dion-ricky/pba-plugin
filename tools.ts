// Tool surface for the PBA loop. Registered under the "pba_" prefix so the
// effective names are directly callable by agents (codemode: false).
//
// The three submission tools are how role sessions hand structured results
// back to the orchestrator. They validate phase + payload, persist artifacts,
// and record the submission marker the orchestrator waits for — the model
// never decides loop control flow, it only files artifacts.

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import {
  appendEvents,
  findLoopBySession,
  loadAllLoops,
  loopDirOf,
  readState,
  updateState,
  writeArtifact,
  type LoopRecord,
  type PbaState,
} from "./state"
import { startLoop, driveLoop, statusReport as renderStatus, type LoopConfig } from "./orchestrator"
import { plannerPrompt } from "./prompts"

export type SessionLoopMap = Map<string, string>

interface ToolArgs {
  [key: string]: unknown
}

/**
 * In-process per-loop async mutex. Parallel perspective auditors file their
 * `pba_verdict` calls concurrently against the same state.json; the lock
 * serializes their read-modify-write cycles so no verdict record is lost.
 */
const loopLocks = new Map<string, Promise<unknown>>()

function withLoopLock<T>(loopDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = loopLocks.get(loopDir) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  loopLocks.set(loopDir, next.then(() => undefined, () => undefined))
  return next
}

const strArray = {
  type: "array",
  items: { type: "string" },
} as const

function fail(message: string): never {
  throw new Error(`[pba] ${message}`)
}

function readString(args: ToolArgs, key: string, opts: { optional?: boolean } = {}): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return undefined
    fail(`missing required argument "${key}"`)
  }
  if (typeof value !== "string") fail(`argument "${key}" must be a string`)
  return value
}

function readStringArray(args: ToolArgs, key: string, opts: { optional?: boolean } = {}): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) {
    if (opts.optional) return undefined
    fail(`missing required argument "${key}"`)
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`argument "${key}" must be an array of strings`)
  }
  return value as string[]
}

async function resolveLoop(
  config: LoopConfig,
  sessionLoops: SessionLoopMap,
  sessionID: string,
): Promise<LoopRecord> {
  const dirFor = (loopId: string) => loopDirOf(config.rootDir, config.stateDirName, loopId)
  const cached = sessionLoops.get(sessionID)
  if (cached) {
    try {
      return { loopDir: dirFor(cached), state: await readState(dirFor(cached)) }
    } catch {
      sessionLoops.delete(sessionID) // stale cache; fall through to scan
    }
  }
  const loops = await loadAllLoops(config.rootDir, config.stateDirName)
  const match = findLoopBySession(loops, sessionID)
  if (!match) {
    fail(
      `this session is not part of any PBA loop. Start one with \`pba_start\` (or the /pba command), and pass its loopId explicitly where supported.`,
    )
  }
  sessionLoops.set(sessionID, match.state.loopId)
  return match
}

export async function registerTools(
  ctx: PluginContext,
  config: LoopConfig,
  sessionLoops: SessionLoopMap,
): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "pba_start",
      description:
        "Start a plan-build-audit (PBA) loop. The planner phase runs in the calling session: after start, plan and submit the plan with pba_plan_submit, then the loop hands the plan to a builder subagent; an auditor reviews it and disapproval sends work back to the planner. Use for non-trivial changes the user wants planned, built, and audited.",
      input: {
        type: "object",
        properties: {
          spec: { type: "string", description: "Full task description: what to build/change and any constraints. Copy the user's request." },
          title: { type: "string", description: "Optional short title used in the loop ID." },
        },
        required: ["spec"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (raw, context: ToolContext) => {
        const args = (raw ?? {}) as ToolArgs
        const spec = readString(args, "spec")!.trim()
        if (spec.length === 0) fail("spec must not be empty")
        const title = readString(args, "title", { optional: true })
        const loopId = await startLoop(ctx, config, {
          spec,
          title,
          originSessionID: context.sessionID,
        })
        sessionLoops.set(context.sessionID, loopId)
        const loopDir = loopDirOf(config.rootDir, config.stateDirName, loopId)
        const state = await readState(loopDir)
        return {
          content:
            `PBA loop \`${loopId}\` started. You are the PLANNER for this loop — planning happens in this session.\n\n` +
            plannerPrompt(state, loopDir) +
            `\n\nCheck on the loop with pba_status or /pba-status.`,
        }
      },
    })

    editor.add({
      name: "pba_status",
      description: "Show the status of one PBA loop (by loopId) or summarize all loops in this repo.",
      input: {
        type: "object",
        properties: {
          loopId: { type: "string", description: "Optional loopId. Omit to list all loops." },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (raw) => {
        const args = (raw ?? {}) as ToolArgs
        const loopId = readString(args, "loopId", { optional: true })
        return { content: await renderStatus(config, loopId) }
      },
    })

    editor.add({
      name: "pba_state_read",
      description: "Read the current PBA loop state for this session (loop phase, attempt, artifacts, verdicts).",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async (_raw, context: ToolContext) => {
        const { loopDir, state } = await resolveLoop(config, sessionLoops, context.sessionID)
        return {
          content:
            `Loop directory: ${loopDir}\n\n` +
            JSON.stringify(state, null, 2),
        }
      },
    })

    editor.add({
      name: "pba_plan_submit",
      description:
        "PLANNER ONLY, mandatory final action: submit the implementation plan. Writes plan.md and hands control back to the loop.",
      input: {
        type: "object",
        properties: {
          plan: { type: "string", description: "Full plan in markdown: goal, non-goals, file changes, ordered task breakdown, risks, verification approach." },
          summary: { type: "string", description: "One-sentence plan summary." },
          tasks: { ...strArray, description: "Ordered concrete implementation tasks." },
          acceptanceCriteria: { ...strArray, description: "Checklist the auditor will verify." },
        },
        required: ["plan", "summary", "tasks", "acceptanceCriteria"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (raw, context: ToolContext) => {
        const args = (raw ?? {}) as ToolArgs
        const plan = readString(args, "plan")!
        const summary = readString(args, "summary")!
        const tasks = readStringArray(args, "tasks")!
        const criteria = readStringArray(args, "acceptanceCriteria")!
        if (tasks.length === 0) fail("tasks must contain at least one task")
        if (criteria.length === 0) fail("acceptanceCriteria must contain at least one criterion")

        const { loopDir, state } = await resolveLoop(config, sessionLoops, context.sessionID)
        requirePhase(state, "plan", "pba_plan_submit")
        if (state.submission?.kind === "plan") {
          fail(
            `plan already submitted for attempt ${state.attempt} — do not call pba_plan_submit again`,
          )
        }
        await writeArtifact(loopDir, "plan.md", plan)
        await updateState(loopDir, (draft) => {
          draft.planSummary = summary
          draft.tasks = tasks
          draft.acceptanceCriteria = criteria
          draft.submission = { kind: "plan", at: new Date().toISOString() }
        })
        await appendEvents(loopDir, [{ event: "plan.submitted", tasks: tasks.length, criteria: criteria.length }])
        // The plan is persisted: hand control to the loop driver, which hands
        // the plan to the builder subagent. Fire-and-forget; the activeLoops
        // guard makes a double kick (e.g. during a revision drive) a no-op.
        void driveLoop(ctx, config, state.loopId)
        return { content: "Plan submitted and saved to plan.md. The builder subagent is starting in the background; progress will be posted to this session. Your phase is complete." }
      },
    })

    editor.add({
      name: "pba_build_complete",
      description:
        "BUILDER ONLY, mandatory final action: report that the plan was implemented. Records the change summary for the auditor.",
      input: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was implemented; mention any deviations from the plan and why." },
          changedFiles: { ...strArray, description: "Files created or modified." },
          notes: { type: "string", description: "Optional context for the auditor." },
        },
        required: ["summary", "changedFiles"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (raw, context: ToolContext) => {
        const args = (raw ?? {}) as ToolArgs
        const summary = readString(args, "summary")!
        const changedFiles = readStringArray(args, "changedFiles")!
        const notes = readString(args, "notes", { optional: true })
        if (changedFiles.length === 0) fail("changedFiles must list the files you touched")

        const { loopDir, state } = await resolveLoop(config, sessionLoops, context.sessionID)
        requirePhase(state, "build", "pba_build_complete")
        await updateState(loopDir, (draft) => {
          draft.buildSummary = notes ? `${summary} (notes: ${notes})` : summary
          draft.changedFiles = changedFiles
          draft.submission = { kind: "build", at: new Date().toISOString() }
        })
        await appendEvents(loopDir, [{ event: "build.completed", files: changedFiles.length }])
        return { content: "Build completion recorded. The loop will now start the auditor. Your phase is complete." }
      },
    })

    editor.add({
      name: "pba_verdict",
      description:
        "AUDITOR ONLY, mandatory final action: submit the audit decision. Pass the assigned `perspective` to write review-<perspective>.md as one of the parallel perspective auditors; omitting it is ONLY accepted for genuinely legacy loops without parallel audit state (in a parallel-audit loop the call fails with an error naming the `perspective` argument). Drives the loop (approve = done, disapprove = back to the planner).",
      input: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["approved", "disapproved"], description: "approved = implementation meets the plan; disapproved = findings must be fixed." },
          report: { type: "string", description: "Full audit report in markdown: what was checked, what passed, what failed." },
          findings: { ...strArray, description: "Numbered, specific, actionable issues. Non-empty when disapproved; empty when approved." },
          perspective: { type: "string", description: "Your assigned audit perspective (e.g. spec-adherence, bugs, security, code-quality). Required for parallel perspective auditors." },
        },
        required: ["verdict", "report", "findings"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (raw, context: ToolContext) => {
        const args = (raw ?? {}) as ToolArgs
        const verdict = readString(args, "verdict")!
        const report = readString(args, "report")!
        const findings = readStringArray(args, "findings")!
        const perspective = readString(args, "perspective", { optional: true })
        if (verdict !== "approved" && verdict !== "disapproved") {
          fail(`verdict must be "approved" or "disapproved", got "${verdict}"`)
        }
        if (verdict === "disapproved" && findings.length === 0) {
          fail("a disapproval requires at least one specific finding")
        }
        if (verdict === "approved" && findings.length > 0) {
          fail("an approval must have empty findings; list concerns in the report instead")
        }

        const { loopDir, state } = await resolveLoop(config, sessionLoops, context.sessionID)
        requirePhase(state, "audit", "pba_verdict")
        if (perspective !== undefined && !config.auditPerspectives.includes(perspective)) {
          fail(
            `unknown perspective "${perspective}" — configured perspectives: ${config.auditPerspectives.join(", ")}`,
          )
        }
        // Serialize concurrent perspective verdicts on the same state.json.
        return withLoopLock(loopDir, async () => {
          const fresh = await readState(loopDir)
          requirePhase(fresh, "audit", "pba_verdict")
          if (perspective !== undefined) {
            if (!config.auditPerspectives.includes(perspective)) {
              fail(
                `unknown perspective "${perspective}" — configured perspectives: ${config.auditPerspectives.join(", ")}`,
              )
            }
            if (fresh.perspectiveVerdicts?.some((v) => v.perspective === perspective && v.attempt === fresh.attempt)) {
              fail(
                `a "${perspective}" verdict for attempt ${fresh.attempt} is already recorded — do not call pba_verdict again`,
              )
            }
            await writeArtifact(loopDir, `review-${perspective}.md`, report)
            await updateState(loopDir, (draft) => {
              draft.perspectiveVerdicts = [
                ...(draft.perspectiveVerdicts ?? []),
                { perspective, attempt: draft.attempt, verdict, findings, report, at: new Date().toISOString() },
              ]
              draft.submission = { kind: "verdict", at: new Date().toISOString() }
            })
            await appendEvents(loopDir, [
              { event: "perspective.verdict", perspective, verdict, findings: findings.length, attempt: fresh.attempt },
            ])
            return {
              content:
                verdict === "approved"
                  ? `Perspective verdict recorded: ${perspective} APPROVED (written to review-${perspective}.md). Your phase is complete.`
                  : `Perspective verdict recorded: ${perspective} DISAPPROVED with ${findings.length} finding(s) (written to review-${perspective}.md). Your phase is complete.`,
            }
          }
          // Legacy single-auditor path (kept for loops resumed from old
          // state). Refuse it in parallel-audit loops: a stray verdict
          // without a perspective would otherwise bypass the merge and let
          // one session decide the loop outcome.
          const isParallelAuditLoop =
            Object.keys(fresh.sessions).some((k) => k.startsWith("audit:")) ||
            (fresh.perspectiveVerdicts?.length ?? 0) > 0
          if (isParallelAuditLoop) {
            fail(
              `this loop uses parallel perspective auditing — call pba_verdict with your assigned \`perspective\` argument (configured perspectives: ${config.auditPerspectives.join(", ")})`,
            )
          }
          await writeArtifact(loopDir, "review.md", report)
          await updateState(loopDir, (draft) => {
            draft.verdicts.push({
              attempt: draft.attempt,
              verdict,
              findings,
              report,
              at: new Date().toISOString(),
            })
            draft.submission = { kind: "verdict", at: new Date().toISOString() }
          })
          await appendEvents(loopDir, [{ event: "verdict.submitted", verdict, findings: findings.length }])
          return {
            content:
              verdict === "approved"
                ? "Verdict recorded: APPROVED. The loop will finalize. Your phase is complete."
                : `Verdict recorded: DISAPPROVED with ${findings.length} finding(s). The loop will send them back to the planner. Your phase is complete.`,
          }
        })
      },
    })
  })
}

function requirePhase(state: PbaState, phase: "plan" | "build" | "audit", tool: string): void {
  if (state.status !== "active") {
    fail(`loop \`${state.loopId}\` is ${state.status}; ${tool} is not accepted anymore`)
  }
  if (state.phase !== phase) {
    fail(
      `loop \`${state.loopId}\` is in phase "${state.phase}", not "${phase}" — ${tool} is only valid in the ${phase} phase. Call pba_state_read to see the current state.`,
    )
  }
}
