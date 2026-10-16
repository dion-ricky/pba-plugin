// Loop driver: deterministically advances plan -> build -> audit by spawning
// role sessions and reacting to the structured submissions the role tools
// record. The LLM never decides the loop; this module does.

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import { promises as fs } from "node:fs"
import {
  appendEvents,
  formatState,
  latestVerdict,
  loadAllLoops,
  loopDirOf,
  makeLoopId,
  now,
  readState,
  rebuildIndex,
  updateState,
  writeState,
  type PbaRole,
  type PbaState,
} from "./state"
import { AGENT_BY_ROLE, auditorPrompt, builderPrompt, plannerPrompt } from "./prompts"

export interface PbaOptions {
  /** Directory name for coordination state, relative to the repo root. */
  stateDir?: string
  /** Maximum build attempts before the loop escalates to the user. */
  maxAttempts?: number
  /** Optional per-role model override as "provider/model". */
  models?: { plan?: string; build?: string; audit?: string }
}

export interface LoopConfig {
  rootDir: string
  stateDirName: string
  maxAttempts: number
  models: { plan?: string; build?: string; audit?: string }
}

export function resolveConfig(rootDir: string, options: PbaOptions | undefined): LoopConfig {
  const models = options?.models ?? {}
  const maxAttempts = options?.maxAttempts ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`[pba] options.maxAttempts must be a positive integer, got ${JSON.stringify(options?.maxAttempts)}`)
  }
  for (const role of ["plan", "build", "audit"] as const) {
    const ref = models[role]
    if (ref !== undefined && !/^[^/]+\/[^/]+$/.test(ref)) {
      throw new Error(`[pba] options.models.${role} must look like "provider/model", got "${ref}"`)
    }
  }
  return { rootDir, stateDirName: options?.stateDir ?? ".pba", maxAttempts, models }
}

export function loopDirFor(config: LoopConfig, loopId: string): string {
  return loopDirOf(config.rootDir, config.stateDirName, loopId)
}

/** Thrown when a phase session finishes without the mandatory submission tool call. */
class PhaseIncomplete extends Error {}

/** What each phase's session must file to count as complete. */
const EXPECTED_SUBMISSION: Record<PbaRole, "plan" | "build" | "verdict"> = {
  plan: "plan",
  build: "build",
  audit: "verdict",
}

/** Loops currently being driven by this plugin instance (one server process). */
const activeLoops = new Set<string>()

export function isLoopActive(loopId: string): boolean {
  return activeLoops.has(loopId)
}

async function spawnPhaseSession(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  role: PbaRole,
): Promise<string> {
  // Model resolution order: explicit per-role override > the origin (main)
  // session's selected model, variant included > OpenCode's config default.
  let model: { id: string; providerID: string; variant?: string } | undefined
  const override = config.models[role]
  if (override) {
    const slash = override.indexOf("/")
    model = { providerID: override.slice(0, slash), id: override.slice(slash + 1) }
  } else {
    try {
      const origin = await ctx.session.get({ sessionID: state.originSessionID })
      if (origin.model) {
        model = { providerID: origin.model.providerID, id: origin.model.id, variant: origin.model.variant }
      }
    } catch (cause) {
      console.error(`[pba] could not read origin session model: ${(cause as Error).message}`)
    }
  }

  const created = await ctx.session.create({
    title: `PBA ${state.loopId} · ${role} (attempt ${state.attempt})`,
    agent: AGENT_BY_ROLE[role],
    parentID: state.originSessionID,
    location: { directory: config.rootDir },
    ...(model ? { model } : {}),
  })
  const sessionID = created.id
  await updateState(loopDirFor(config, state.loopId), (draft) => {
    draft.sessions[role] = sessionID
  })
  return sessionID
}

async function runPhase(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  role: PbaRole,
  promptText: string,
): Promise<void> {
  const loopDir = loopDirFor(config, state.loopId)
  const sessionID = await spawnPhaseSession(ctx, config, state, role)
  await appendEvents(loopDir, [{ event: "phase.start", phase: role, attempt: state.attempt, sessionID }])
  await ctx.session.prompt({ sessionID, text: promptText })
  await ctx.session.wait({ sessionID })
  const info = await ctx.session.get({ sessionID })
  const outcome = info.outcome
  const fresh = await readState(loopDir)
  if (fresh.submission?.kind !== EXPECTED_SUBMISSION[role]) {
    await appendEvents(loopDir, [{ event: "phase.incomplete", phase: role, attempt: state.attempt, outcome }])
    throw new PhaseIncomplete(
      `the ${role} session ended (outcome: ${outcome ?? "unknown"}) without calling its mandatory submission tool`,
    )
  }
  await appendEvents(loopDir, [{ event: "phase.submitted", phase: role, attempt: state.attempt }])
}

async function announce(ctx: PluginContext, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.session.synthetic({ sessionID, text })
  } catch (cause) {
    // Origin session may be gone (user closed it); the loop continues on disk.
    console.error(`[pba] could not notify origin session ${sessionID}: ${(cause as Error).message}`)
  }
}

function deriveTitle(spec: string): string {
  return spec.trim().split(/\s+/).slice(0, 8).join(" ") || "pba loop"
}

export interface StartLoopInput {
  spec: string
  title?: string
  originSessionID: string
}

/**
 * Create the loop's coordination state and start driving it in the background.
 * Returns the loopId immediately; callers surface it to the user right away.
 */
export async function startLoop(
  ctx: PluginContext,
  config: LoopConfig,
  input: StartLoopInput,
): Promise<string> {
  const spec = input.spec.trim()
  if (spec.length === 0) {
    throw new Error("[pba] cannot start a loop with an empty spec")
  }
  const title = (input.title?.trim() || deriveTitle(spec)).slice(0, 80)
  const loopId = makeLoopId(title)
  const loopDir = loopDirFor(config, loopId)
  await fs.mkdir(loopDir, { recursive: true })

  const state: PbaState = {
    version: 1,
    loopId,
    title,
    spec,
    originSessionID: input.originSessionID,
    status: "active",
    phase: "plan",
    attempt: 1,
    maxAttempts: config.maxAttempts,
    phaseRetries: 0,
    revision: false,
    sessions: {},
    submission: null,
    planSummary: null,
    tasks: [],
    acceptanceCriteria: [],
    buildSummary: null,
    changedFiles: [],
    verdicts: [],
    lastError: null,
    createdAt: now(),
    updatedAt: now(),
  }
  await writeState(loopDir, state)
  await appendEvents(loopDir, [{ event: "loop.created", title, originSessionID: input.originSessionID }])
  await rebuildIndex(config.rootDir, config.stateDirName)

  void driveLoop(ctx, config, loopId)
  return loopId
}

/** Continue a paused/active loop from its persisted state. */
export async function resumeLoop(
  ctx: PluginContext,
  config: LoopConfig,
  loopId: string,
  requestedBy: string,
): Promise<string> {
  const loopDir = loopDirFor(config, loopId)
  const state = await readState(loopDir)
  if (state.phase === "done") {
    return `Loop \`${loopId}\` is already finished (status: ${state.status}).`
  }
  if (state.status === "escalated") {
    return `Loop \`${loopId}\` is escalated; raise maxAttempts in opencode.json options before resuming.`
  }
  if (isLoopActive(loopId)) {
    return `Loop \`${loopId}\` is already running (phase "${state.phase}"); check with \`/pba-status ${loopId}\`.`
  }
  await updateState(loopDir, (draft) => {
    draft.status = "active"
    draft.lastError = null
  })
  await appendEvents(loopDir, [{ event: "loop.resumed", requestedBy }])
  void driveLoop(ctx, config, loopId)
  return `Loop \`${loopId}\` resumed from phase "${state.phase}" (attempt ${state.attempt}/${state.maxAttempts}).`
}

/**
 * Drive the loop until it reaches a terminal state (completed/escalated/failed)
 * or pauses. A single loop is driven at most once per plugin instance; resume
 * paths re-enter safely because terminal and in-flight states are checked here.
 */
async function driveLoop(ctx: PluginContext, config: LoopConfig, loopId: string): Promise<void> {
  if (activeLoops.has(loopId)) return
  activeLoops.add(loopId)
  try {
    for (;;) {
      try {
        await runLoopTurns(ctx, config, loopId)
        return
      } catch (cause) {
        const loopDir = loopDirFor(config, loopId)
        // One retry of the current phase when a session ended without submitting.
        if (cause instanceof PhaseIncomplete) {
          const state = await readState(loopDir)
          if (state.status === "active" && state.phaseRetries < 1) {
            await updateState(loopDir, (draft) => {
              draft.phaseRetries += 1
            })
            await appendEvents(loopDir, [{ event: "phase.retry", phase: state.phase, error: cause.message }])
            await announce(
              ctx,
              state.originSessionID,
              `⚠️ **PBA \`${loopId}\`** — ${cause.message}. Retrying the ${state.phase} phase once.`,
            )
            continue
          }
        }
        await failLoop(ctx, config, loopId, cause)
        return
      }
    }
  } finally {
    activeLoops.delete(loopId)
  }
}

/** One pass of the phase machine: runs phases until a terminal transition. */
async function runLoopTurns(ctx: PluginContext, config: LoopConfig, loopId: string): Promise<void> {
  const loopDir = loopDirFor(config, loopId)
  for (;;) {
    const state = await readState(loopDir)
    if (state.status !== "active") return

    if (state.phase === "plan") {
      if (state.submission?.kind !== "plan") {
        await runPhase(ctx, config, state, "plan", plannerPrompt(state, loopDir))
      }
      const s = await readState(loopDir)
      if (s.submission?.kind !== "plan") {
        throw new PhaseIncomplete("planner did not submit a plan")
      }
      await updateState(loopDir, (draft) => {
        draft.phase = "build"
        draft.submission = null
        draft.phaseRetries = 0
      })
      await rebuildIndex(config.rootDir, config.stateDirName)
      await announce(
        ctx,
        s.originSessionID,
        `📋 **PBA \`${loopId}\`** — plan ready (attempt ${s.attempt}/${s.maxAttempts}): ${s.planSummary ?? s.title}\nBuilder is starting.`,
      )
      continue
    }

    if (state.phase === "build") {
      if (state.submission?.kind !== "build") {
        await runPhase(ctx, config, state, "build", builderPrompt(state, loopDir))
      }
      const s = await readState(loopDir)
      if (s.submission?.kind !== "build") {
        throw new PhaseIncomplete("builder did not report completion")
      }
      await updateState(loopDir, (draft) => {
        draft.phase = "audit"
        draft.submission = null
        draft.phaseRetries = 0
      })
      await rebuildIndex(config.rootDir, config.stateDirName)
      await announce(
        ctx,
        s.originSessionID,
        `🔨 **PBA \`${loopId}\`** — build finished (attempt ${s.attempt}/${s.maxAttempts}): ${s.buildSummary ?? "no summary"}\nAuditor is starting.`,
      )
      continue
    }

    if (state.phase === "audit") {
      if (state.submission?.kind !== "verdict") {
        await runPhase(ctx, config, state, "audit", auditorPrompt(state, loopDir))
      }
      const s = await readState(loopDir)
      const verdict = latestVerdict(s)
      if (!verdict) {
        throw new PhaseIncomplete("auditor did not submit a verdict")
      }

      if (verdict.verdict === "approved") {
        await updateState(loopDir, (draft) => {
          draft.phase = "done"
          draft.status = "completed"
          draft.submission = null
          draft.phaseRetries = 0
        })
        await appendEvents(loopDir, [{ event: "loop.completed", attempt: s.attempt }])
        await rebuildIndex(config.rootDir, config.stateDirName)
        await announce(
          ctx,
          s.originSessionID,
          `✅ **PBA \`${loopId}\` completed** on attempt ${s.attempt}/${s.maxAttempts}.\nPlan: ${loopDir}/plan.md\nAudit report: ${loopDir}/review.md\n${s.buildSummary ? `Build summary: ${s.buildSummary}\n` : ""}Review the diff and commit when satisfied.`,
        )
        return
      }

      if (s.attempt >= s.maxAttempts) {
        await updateState(loopDir, (draft) => {
          draft.phase = "done"
          draft.status = "escalated"
          draft.submission = null
          draft.lastError = `auditor disapproved ${s.attempt} time(s); attempt budget exhausted`
        })
        await appendEvents(loopDir, [{ event: "loop.escalated", attempts: s.attempt }])
        await rebuildIndex(config.rootDir, config.stateDirName)
        await announce(
          ctx,
          s.originSessionID,
          `🚨 **PBA \`${loopId}\` escalated** — the auditor disapproved ${s.attempt} time(s) and the attempt budget (${s.maxAttempts}) is exhausted.\nLatest findings are in ${loopDir}/review.md.\nDecide yourself, adjust the spec and run \`/pba\` again, or raise \`maxAttempts\` and run \`/pba-resume ${loopId}\`.`,
        )
        return
      }

      await updateState(loopDir, (draft) => {
        draft.attempt += 1
        draft.revision = true
        draft.phase = "plan"
        draft.submission = null
        draft.phaseRetries = 0
      })
      await appendEvents(loopDir, [{ event: "loop.revision", nextAttempt: s.attempt + 1 }])
      await rebuildIndex(config.rootDir, config.stateDirName)
      await announce(
        ctx,
        s.originSessionID,
        `🔁 **PBA \`${loopId}\`** — auditor disapproved (attempt ${s.attempt}/${s.maxAttempts}, ${verdict.findings.length} finding(s)). Sending findings back to the planner for revision.`,
      )
      continue
    }

    // Unknown phase value in state: stop instead of spinning.
    throw new Error(`[pba] unknown phase "${String((state as { phase: unknown }).phase)}" in state`)
  }
}

async function failLoop(
  ctx: PluginContext,
  config: LoopConfig,
  loopId: string,
  cause: unknown,
): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause)
  const interrupted = /abort|interrupt|cancel/i.test(message)
  try {
    const loopDir = loopDirFor(config, loopId)
    const state = await readState(loopDir)
    await updateState(loopDir, (draft) => {
      draft.status = interrupted ? "paused" : "failed"
      draft.lastError = message
    })
    await appendEvents(loopDir, [{ event: interrupted ? "loop.paused" : "loop.failed", error: message }])
    await rebuildIndex(config.rootDir, config.stateDirName)
    await announce(
      ctx,
      state.originSessionID,
      `${interrupted ? "⏸️" : "❌"} **PBA \`${loopId}\` ${interrupted ? "paused" : "failed"}**: ${message}\n${interrupted ? `Resume with \`/pba-resume ${loopId}\`.` : `Details: ${formatState(state)}`}`,
    )
  } catch (reporting) {
    // State itself is unreadable/corrupt: log loudly, nothing else we can do.
    console.error(`[pba] loop ${loopId} failed: ${message}; error reporting also failed: ${(reporting as Error).message}`)
  }
}


export async function statusReport(config: LoopConfig, loopId?: string): Promise<string> {
  if (loopId) {
    const state = await readState(loopDirFor(config, loopId))
    return `**PBA loop ${loopId}**\n\`\`\`\n${formatState(state)}\n\`\`\`\nArtifacts: ${loopDirFor(config, loopId)}`
  }
  const loops = await loadAllLoops(config.rootDir, config.stateDirName)
  if (loops.length === 0) {
    return "No PBA loops found. Start one with `/pba <spec>`."
  }
  const lines = loops.map(({ state }) => {
    const verdict = latestVerdict(state)
    const v = verdict ? ` · last verdict ${verdict.verdict}` : ""
    return `- \`${state.loopId}\` — ${state.status} · ${state.phase} · attempt ${state.attempt}/${state.maxAttempts} · ${state.title}${v}`
  })
  return `**PBA loops** (${loops.length})\n${lines.join("\n")}\n\nDetail: \`/pba-status <loopId>\` · Resume: \`/pba-resume <loopId>\``
}
