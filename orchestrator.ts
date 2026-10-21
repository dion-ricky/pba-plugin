// Loop driver: deterministically advances plan -> build -> audit by spawning
// role sessions and reacting to the structured submissions the role tools
// record. The LLM never decides the loop; this module does.

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import { createHash } from "node:crypto"
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
  writeArtifact,
  writeState,
  type PerspectiveVerdictRecord,
  type PbaRole,
  type PbaState,
  type PbaVerdict,
} from "./state"
import { AGENT_BY_ROLE, auditorPrompt, builderPrompt, DEFAULT_PERSPECTIVES, plannerPrompt } from "./prompts"
import {
  HERDR_MAX_RATIO,
  HERDR_MIN_RATIO,
  HerdrError,
  herdrAgentPrompt,
  herdrAgentRead,
  herdrAgentStart,
  herdrPaneClose,
  herdrPaneLayout,
  herdrPrecheck,
  herdrSplitPane,
  planBalancedColumn,
  resolveOriginPane,
} from "./herdr"

export interface PbaOptions {
  /** Directory name for coordination state, relative to the repo root. */
  stateDir?: string
  /** Maximum build attempts before the loop escalates to the user. */
  maxAttempts?: number
  /**
   * Optional per-role model override as "provider/model". Planning has no
   * override: it runs in the main session, which keeps its own model.
   */
  models?: { build?: string; audit?: string }
  /** Perspectives reviewed in parallel during the audit phase. */
  auditPerspectives?: string[]
  /**
   * How role sessions are driven: "subagent" (default) spawns plugin child
   * sessions; "herdr" launches full OpenCode TUIs in herdr panes via the
   * herdr CLI (requires OpenCode to run inside herdr).
   */
  control?: "subagent" | "herdr"
  /** herdr driver tuning; only used when control is "herdr". */
  herdr?: { ratio?: number; promptTimeoutMs?: number }
}

export interface LoopConfig {
  rootDir: string
  stateDirName: string
  maxAttempts: number
  models: { build?: string; audit?: string }
  auditPerspectives: string[]
  control: "subagent" | "herdr"
  herdr: { ratio: number; promptTimeoutMs: number }
}

export function resolveConfig(rootDir: string, options: PbaOptions | undefined): LoopConfig {
  // Read loosely: runtime configs come from opencode.json(c), where a stale
  // `models.plan` key may still be present and must be rejected loudly.
  const rawModels = (options?.models ?? {}) as { plan?: string; build?: string; audit?: string }
  const maxAttempts = options?.maxAttempts ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`[pba] options.maxAttempts must be a positive integer, got ${JSON.stringify(options?.maxAttempts)}`)
  }
  if (rawModels.plan !== undefined) {
    throw new Error(
      "[pba] options.models.plan is no longer supported: planning runs in the main session, which keeps its own model",
    )
  }
  for (const role of ["build", "audit"] as const) {
    const ref = rawModels[role]
    if (ref !== undefined && !/^[^/]+\/[^/]+$/.test(ref)) {
      throw new Error(`[pba] options.models.${role} must look like "provider/model", got "${ref}"`)
    }
  }
  const models: LoopConfig["models"] = { build: rawModels.build, audit: rawModels.audit }
  const auditPerspectives = options?.auditPerspectives ?? [...DEFAULT_PERSPECTIVES]
  const invalid = !Array.isArray(auditPerspectives) ||
    auditPerspectives.length === 0 ||
    auditPerspectives.some((p) => typeof p !== "string" || p.length === 0 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p))
  if (invalid) {
    throw new Error(
      `[pba] options.auditPerspectives must be a non-empty array of kebab-case perspective names, got ${JSON.stringify(options?.auditPerspectives)}`,
    )
  }
  const control = options?.control ?? "subagent"
  if (control !== "subagent" && control !== "herdr") {
    throw new Error(`[pba] options.control must be "subagent" or "herdr", got ${JSON.stringify(options?.control)}`)
  }
  const rawHerdr = options?.herdr
  if (
    rawHerdr !== undefined &&
    (typeof rawHerdr !== "object" || rawHerdr === null || Array.isArray(rawHerdr))
  ) {
    throw new Error(
      `[pba] options.herdr must be an object with optional ratio and promptTimeoutMs, got ${JSON.stringify(options?.herdr)}`,
    )
  }
  const herdrRatio = rawHerdr?.ratio ?? 0.5
  if (
    typeof herdrRatio !== "number" ||
    !Number.isFinite(herdrRatio) ||
    herdrRatio < HERDR_MIN_RATIO ||
    herdrRatio > HERDR_MAX_RATIO
  ) {
    throw new Error(
      `[pba] options.herdr.ratio must be a number in [${HERDR_MIN_RATIO}, ${HERDR_MAX_RATIO}] ` +
        `(herdr clamps --ratio to that range), got ${JSON.stringify(rawHerdr?.ratio)}`,
    )
  }
  const herdrPromptTimeoutMs = rawHerdr?.promptTimeoutMs ?? 600000
  if (!Number.isInteger(herdrPromptTimeoutMs) || herdrPromptTimeoutMs < 1) {
    throw new Error(
      `[pba] options.herdr.promptTimeoutMs must be a positive integer, got ${JSON.stringify(rawHerdr?.promptTimeoutMs)}`,
    )
  }
  return {
    rootDir,
    stateDirName: options?.stateDir ?? ".pba",
    maxAttempts,
    models,
    auditPerspectives,
    control,
    herdr: { ratio: herdrRatio, promptTimeoutMs: herdrPromptTimeoutMs },
  }
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

/**
 * Roles that run in spawned child sessions. Planning is the exception: it runs
 * in the origin (main) session, which is prompted in place instead.
 */
type SpawnRole = Exclude<PbaRole, "plan">

async function spawnPhaseSession(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  role: SpawnRole,
  sessionKey?: PbaRole | `audit:${string}`,
  paneId?: string,
): Promise<string> {
  if (config.control === "herdr") {
    return spawnHerdrPhaseSession(ctx, config, state, role, sessionKey, paneId)
  }
  const model = await resolvePhaseModel(ctx, config, state, role)

  const created = await ctx.session.create({
    title: `PBA ${state.loopId} · ${sessionKey ?? role} (attempt ${state.attempt})`,
    agent: AGENT_BY_ROLE[role],
    parentID: state.originSessionID,
    location: { directory: config.rootDir },
    ...(model ? { model } : {}),
  })
  const sessionID = created.id
  await updateState(loopDirFor(config, state.loopId), (draft) => {
    draft.sessions[sessionKey ?? role] = sessionID
  })
  return sessionID
}

/**
 * Model resolution order: explicit per-role override > the origin (main)
 * session's selected model, variant included > OpenCode's config default.
 * Shared by the subagent and herdr control paths.
 */
async function resolvePhaseModel(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  role: SpawnRole,
): Promise<{ id: string; providerID: string; variant?: string } | undefined> {
  const override = config.models[role]
  if (override) {
    const slash = override.indexOf("/")
    return { providerID: override.slice(0, slash), id: override.slice(slash + 1) }
  }
  try {
    const origin = await ctx.session.get({ sessionID: state.originSessionID })
    if (origin.model) {
      return { providerID: origin.model.providerID, id: origin.model.id, variant: origin.model.variant }
    }
  } catch (cause) {
    console.error(`[pba] could not read origin session model: ${(cause as Error).message}`)
  }
  return undefined
}

/** herdr agent name for a role key; unique per loop, role, attempt and phase retry. */
function herdrAgentName(state: PbaState, key: string): string {
  const retry = state.phaseRetries > 0 ? `r${state.phaseRetries}` : ""
  const tag = `a${state.attempt}${retry}`
  // herdr agent names must be 1-32 chars of [a-z0-9-_] starting with a letter
  // (verified against herdr 0.9.5). The loopId is far too long to embed, so a
  // hash keeps names unique per loop/role/attempt/retry while the readable
  // key prefix keeps the panes identifiable in the herdr UI.
  const hash = createHash("sha256").update(`${state.loopId}|${key}|${tag}`).digest("hex").slice(0, 8)
  const keySlug = key.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase().slice(0, 10)
  return `pba-${keySlug}-${tag}-${hash}`
}

/**
 * herdr control path (control:"herdr"): run the role as a full OpenCode TUI
 * in a herdr pane. The role session is pre-created via the server API with
 * its agent and model (opencode's TUI has no --agent/--model flags, but
 * `-s <sessionID>` resumes a session — carrying its agent/model/variant —
 * and `--auto` approves non-denied permissions; verified against opencode
 * 2.0.32). Because the session exists before the pane does, role enforcement
 * (tools.ts maps the calling session through state.sessions) works from the
 * first prompt. `paneId` is pre-created by the caller (the audit phase
 * creates all panes before any agent start); when omitted, the pane is split
 * here, anchored to the origin session's pane.
 */
async function spawnHerdrPhaseSession(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  role: SpawnRole,
  sessionKey?: PbaRole | `audit:${string}`,
  paneId?: string,
): Promise<string> {
  const key = sessionKey ?? role
  const loopDir = loopDirFor(config, state.loopId)
  let pane = paneId
  if (!pane) {
    await herdrPrecheck()
    // Anchor the split to the pane the origin session's TUI actually runs in
    // (resolved by session identity, not the plugin host's env — the host's
    // HERDR_PANE_ID can be stale or point at another workspace). Builder: one
    // right split at the configured ratio; auditors (defensive path): down.
    const anchorPane = await resolveOriginPane(state.originSessionID)
    pane = role === "build"
      ? await herdrSplitPane({ sourcePaneId: anchorPane, direction: "right", ratio: config.herdr.ratio, noFocus: true })
      : await herdrSplitPane({ sourcePaneId: anchorPane, direction: "down", noFocus: true })
  }
  const paneID = pane
  const agentName = herdrAgentName(state, key)
  const model = await resolvePhaseModel(ctx, config, state, role)
  // Same creation call as the subagent path — except parentID: resuming a
  // child session makes the TUI open on its Subagents tab instead of the
  // composer (verified live), so herdr sessions are created top-level.
  const created = await ctx.session.create({
    title: `PBA ${state.loopId} · ${key} (attempt ${state.attempt})`,
    agent: AGENT_BY_ROLE[role],
    location: { directory: config.rootDir },
    ...(model ? { model } : {}),
  })
  await herdrAgentStart(agentName, paneID, ["-s", created.id, "--auto"])
  await updateState(loopDir, (draft) => {
    draft.sessions[key] = created.id
    draft.herdrPanes = {
      ...draft.herdrPanes,
      [key]: { paneId: paneID, agent: agentName, nativeSessionID: created.id },
    }
  })
  return created.id
}

/**
 * herdr prompt/wait: deliver the phase prompt to the role's pane and wait for
 * the turn to settle. The wait outcome is a gate only — the on-disk
 * submission check stays authoritative. On `blocked` the origin session is
 * announced and we stop waiting for that pane; on `timeout`/`stalled` the
 * pane is read first so a prompt is never re-sent while one may be pending.
 * Returns the outcome string for the phase events/error message.
 */
async function herdrPromptAndWait(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  key: PbaRole | `audit:${string}`,
  promptText: string,
): Promise<string> {
  const agentName = herdrAgentName(state, key)
  const outcome = await herdrAgentPrompt(agentName, promptText, { timeoutMs: config.herdr.promptTimeoutMs })
  if (outcome === "done") return "succeeded"
  // Read the pane before any retry so a pending prompt is never duplicated;
  // a failed read is only diagnostics and must not mask the real outcome.
  const paneText = await herdrAgentRead(agentName).catch(
    (cause) => `(agent read failed: ${(cause as Error).message})`,
  )
  console.error(`[pba] herdr agent "${agentName}" reported ${outcome} without submitting; pane contents: ${paneText}`)
  if (outcome === "blocked") {
    await announce(
      ctx,
      state.originSessionID,
      `⏸️ **PBA \`${state.loopId}\`** — herdr agent \`${agentName}\` is blocked (permission/question UI in its pane); the loop stopped waiting and will verify the ${key} submission on disk.`,
    )
  }
  return outcome
}

/** Close a role's herdr pane after its disk submission check passed. Cosmetic: a failed close never fails the loop. */
async function closeHerdrPane(config: LoopConfig, loopDir: string, key: string): Promise<void> {
  try {
    const fresh = await readState(loopDir)
    const paneId = fresh.herdrPanes?.[key]?.paneId
    if (!paneId) return
    await herdrPaneClose(paneId)
  } catch (cause) {
    console.error(`[pba] herdr pane close for "${key}" failed (cosmetic; the loop continues): ${(cause as Error).message}`)
  }
}

async function runPhase(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  role: SpawnRole,
  promptText: string,
): Promise<void> {
  const loopDir = loopDirFor(config, state.loopId)
  const sessionID = await spawnPhaseSession(ctx, config, state, role)
  await appendEvents(loopDir, [{ event: "phase.start", phase: role, attempt: state.attempt, sessionID }])
  let outcome: string | undefined
  if (config.control === "herdr") {
    outcome = await herdrPromptAndWait(ctx, config, state, role, promptText)
  } else {
    await ctx.session.prompt({ sessionID, text: promptText })
    await ctx.session.wait({ sessionID })
    const info = await ctx.session.get({ sessionID })
    outcome = info.outcome
  }
  const fresh = await readState(loopDir)
  if (fresh.submission?.kind !== EXPECTED_SUBMISSION[role]) {
    await appendEvents(loopDir, [{ event: "phase.incomplete", phase: role, attempt: state.attempt, outcome }])
    throw new PhaseIncomplete(
      `the ${role} session ended (outcome: ${outcome ?? "unknown"}) without calling its mandatory submission tool`,
    )
  }
  await appendEvents(loopDir, [{ event: "phase.submitted", phase: role, attempt: state.attempt }])
  if (config.control === "herdr") await closeHerdrPane(config, loopDir, role)
}

/**
 * Plan phase in the origin (main) session: no child session is spawned. The
 * origin session is prompted with the planner hand-off and must file its plan
 * via `pba_plan_submit`, mirroring `runPhase` without the spawn.
 */
async function runPlannerInOriginSession(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
): Promise<void> {
  const loopDir = loopDirFor(config, state.loopId)
  const sessionID = state.originSessionID
  await appendEvents(loopDir, [{ event: "phase.start", phase: "plan", attempt: state.attempt, sessionID }])
  try {
    await ctx.session.prompt({ sessionID, text: plannerPrompt(state, loopDir) })
  } catch (cause) {
    throw new Error(
      `[pba] could not prompt the origin session ${sessionID} with the planner hand-off: ${(cause as Error).message}`,
    )
  }
  await ctx.session.wait({ sessionID })
  const fresh = await readState(loopDir)
  if (fresh.submission?.kind !== EXPECTED_SUBMISSION.plan) {
    await appendEvents(loopDir, [{ event: "phase.incomplete", phase: "plan", attempt: state.attempt }])
    throw new PhaseIncomplete(
      "the origin session finished the plan phase without calling its mandatory submission tool (pba_plan_submit)",
    )
  }
  await appendEvents(loopDir, [{ event: "phase.submitted", phase: "plan", attempt: state.attempt }])
}

/** One parallel perspective auditor session; must file its perspective verdict. */
async function runPerspectiveAudit(
  ctx: PluginContext,
  config: LoopConfig,
  state: PbaState,
  perspective: string,
  paneId?: string,
): Promise<void> {
  const loopDir = loopDirFor(config, state.loopId)
  const sessionKey = `audit:${perspective}` as const
  const promptText = auditorPrompt(state, loopDir, perspective)
  const sessionID = await spawnPhaseSession(ctx, config, state, "audit", sessionKey, paneId)
  await appendEvents(loopDir, [
    { event: "phase.start", phase: "audit", perspective, attempt: state.attempt, sessionID },
  ])
  let outcome: string | undefined
  if (config.control === "herdr") {
    outcome = await herdrPromptAndWait(ctx, config, state, sessionKey, promptText)
  } else {
    await ctx.session.prompt({ sessionID, text: promptText })
    await ctx.session.wait({ sessionID })
    const info = await ctx.session.get({ sessionID })
    outcome = info.outcome
  }
  const fresh = await readState(loopDir)
  const filed = fresh.perspectiveVerdicts?.some(
    (v) => v.perspective === perspective && v.attempt === state.attempt,
  )
  if (!filed) {
    await appendEvents(loopDir, [
      { event: "phase.incomplete", phase: "audit", perspective, attempt: state.attempt, outcome },
    ])
    throw new PhaseIncomplete(`the ${perspective} auditor ended without filing its perspective verdict`)
  }
  await appendEvents(loopDir, [
    { event: "phase.submitted", phase: "audit", perspective, attempt: state.attempt },
  ])
  if (config.control === "herdr") await closeHerdrPane(config, loopDir, sessionKey)
}

function perspectiveRecord(
  config: LoopConfig,
  state: PbaState,
  perspective: string,
): PerspectiveVerdictRecord | undefined {
  return state.perspectiveVerdicts?.find(
    (v) => v.perspective === perspective && v.attempt === state.attempt,
  )
}

/** Deterministically merge the perspective verdicts; undefined until all are filed. */
function mergePerspectiveVerdicts(
  config: LoopConfig,
  state: PbaState,
): { verdict: PbaVerdict; findings: string[]; report: string } | undefined {
  const records = config.auditPerspectives.map((p) => perspectiveRecord(config, state, p))
  if (records.some((r) => r === undefined)) return undefined
  const filed = records as PerspectiveVerdictRecord[]
  const verdict: PbaVerdict = filed.every((r) => r.verdict === "approved") ? "approved" : "disapproved"
  const findings = filed.flatMap((r) =>
    r.findings.map((finding) => `[${r.perspective}] ${finding}`),
  )
  const table = filed
    .map((r) => `- ${r.perspective}: ${r.verdict}${r.findings.length > 0 ? ` — ${r.findings.length} finding(s)` : ""}`)
    .join("\n")
  const report =
    `# Audit review (attempt ${state.attempt})\n\nMerged verdict: **${verdict}**\n\n## Per-perspective outcomes\n\n${table}\n\n` +
    filed.map((r) => `## ${r.perspective}\n\n${r.report}`).join("\n\n") +
    "\n"
  return { verdict, findings, report }
}

/**
 * Build the audit column: one right split of the anchor pane (the column),
 * then the balanced down-split tree from planBalancedColumn. Returns the leaf
 * pane ids top-to-bottom, one per auditor. Every split ratio is in
 * [1/3, 0.5], so herdr's [0.1, 0.9] `--ratio` clamp never distorts a row and
 * each leaf gets 1/n of the column (within 1-row rounding).
 */
async function arrangeAuditColumn(anchorPane: string, n: number, ratio: number): Promise<string[]> {
  const plan = planBalancedColumn(n)
  const columnPane = await herdrSplitPane({ sourcePaneId: anchorPane, direction: "right", ratio, noFocus: true })
  const bySlot = new Map<number, string>([[0, columnPane]])
  for (const step of plan.steps) {
    const source = bySlot.get(step.source)
    if (!source) throw new HerdrError(`audit column plan references an unknown slot ${step.source}`)
    const created = await herdrSplitPane({ sourcePaneId: source, direction: "down", ratio: step.ratio, noFocus: true })
    bySlot.set(step.creates, created)
  }
  return plan.leaves.map((slot) => {
    const paneId = bySlot.get(slot)
    if (!paneId) throw new HerdrError(`audit column plan produced no pane for leaf slot ${slot}`)
    return paneId
  })
}

/**
 * Best-effort layout check after the audit column is built: read the tab
 * layout, compare the leaf pane heights, and append a `layout.unequal` event
 * when the spread exceeds herdr's 1-row rounding. Never fatal — a read or
 * parse failure here is cosmetic and must not fail the loop.
 */
async function verifyColumnEqual(loopDir: string, paneIds: string[]): Promise<void> {
  if (paneIds.length < 2) return
  try {
    const layout = await herdrPaneLayout({ paneId: paneIds[0] })
    const wanted = new Set(paneIds)
    const heights = layout.panes
      .filter((p) => p.paneId !== undefined && wanted.has(p.paneId) && p.height !== undefined)
      .map((p) => p.height as number)
    if (heights.length < paneIds.length) return
    const spread = Math.max(...heights) - Math.min(...heights)
    if (spread > 1) {
      await appendEvents(loopDir, [{ event: "layout.unequal", spread, heights }])
      console.error(`[pba] audit column panes are unequal (spread ${spread} rows): ${JSON.stringify(heights)}`)
    }
  } catch (cause) {
    console.error(`[pba] audit column layout check failed (cosmetic; the loop continues): ${(cause as Error).message}`)
  }
}

/**
 * Audit phase: spawn one auditor session per missing perspective in parallel,
 * then deterministically merge the perspective verdicts into review.md and a
 * single VerdictRecord. Idempotent: only missing perspectives are spawned and
 * the merged verdict is only written once per attempt.
 */
async function runAuditPhase(ctx: PluginContext, config: LoopConfig, state: PbaState): Promise<void> {
  const loopDir = loopDirFor(config, state.loopId)
  const missing = config.auditPerspectives.filter((p) => !perspectiveRecord(config, state, p))
  if (missing.length > 0) {
    await announce(
      ctx,
      state.originSessionID,
      `🔎 **PBA \`${state.loopId}\`** — audit: ${missing.length} perspective auditor(s) starting (${missing.join(", ")}).`,
    )
    let panes: string[] | undefined
    if (config.control === "herdr") {
      // All audit panes are created before any agent start. Layout: the
      // first auditor opens a column right of the origin pane (the only
      // pane guaranteed alive — the builder pane was closed after its
      // submission check, and closed herdr panes are gone); the column is
      // then carved into equal rows by a balanced down-split tree (every
      // ratio in [1/3, 0.5], so herdr's [0.1, 0.9] clamp never distorts a
      // row). A layout read-back warns when a row is off by more than the
      // unavoidable 1-row rounding.
      await herdrPrecheck()
      const anchorPane = await resolveOriginPane(state.originSessionID)
      panes = await arrangeAuditColumn(anchorPane, missing.length, config.herdr.ratio)
      await verifyColumnEqual(loopDir, panes)
    }
    await Promise.all(
      missing.map((perspective, i) => runPerspectiveAudit(ctx, config, state, perspective, panes?.[i])),
    )
  }
  const fresh = await readState(loopDir)
  if (config.auditPerspectives.some((p) => !perspectiveRecord(config, fresh, p))) {
    throw new PhaseIncomplete("one or more auditors did not submit their perspective verdict")
  }
  const latest = latestVerdict(fresh)
  if (latest?.attempt === fresh.attempt) return // already merged (retry/resume)
  const merged = mergePerspectiveVerdicts(config, fresh)
  if (!merged) {
    throw new PhaseIncomplete("one or more auditors did not submit their perspective verdict")
  }
  await writeArtifact(loopDir, "review.md", merged.report)
  await updateState(loopDir, (draft) => {
    draft.verdicts.push({
      attempt: draft.attempt,
      verdict: merged.verdict,
      findings: merged.findings,
      report: merged.report,
      at: now(),
    })
  })
  await appendEvents(loopDir, [
    {
      event: "audit.merged",
      attempt: fresh.attempt,
      verdict: merged.verdict,
      findings: merged.findings.length,
      perspectives: config.auditPerspectives,
    },
  ])
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
 * Create the loop's coordination state and return the loopId. The planner
 * phase runs in the origin (main) session: the caller hands the planner role
 * to that session, and the driver is started when the plan is submitted
 * (`pba_plan_submit` fires `driveLoop`).
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
    // The planner runs in the origin session; recording it here keeps
    // findLoopBySession and role lookups working for the plan phase.
    sessions: { plan: input.originSessionID },
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
 * Exported so the `pba_plan_submit` tool can kick the driver once the main
 * session files its plan (startLoop no longer starts it).
 */
export async function driveLoop(ctx: PluginContext, config: LoopConfig, loopId: string): Promise<void> {
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
        await runPlannerInOriginSession(ctx, config, state)
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
        `🔨 **PBA \`${loopId}\`** — build finished (attempt ${s.attempt}/${s.maxAttempts}): ${s.buildSummary ?? "no summary"}\naudit: ${config.auditPerspectives.length} perspective auditors starting (${config.auditPerspectives.join(", ")}).`,
      )
      continue
    }

    if (state.phase === "audit") {
      await runAuditPhase(ctx, config, state)
      const s = await readState(loopDir)
      const verdict = latestVerdict(s)
      if (!verdict) {
        throw new PhaseIncomplete("auditors did not submit a merged verdict")
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
      const disapprovedBy = config.auditPerspectives.filter(
        (p) => perspectiveRecord(config, s, p)?.verdict === "disapproved",
      )
      const byText = disapprovedBy.length > 0 ? `; disapproved by: ${disapprovedBy.join(", ")}` : ""
      await announce(
        ctx,
        s.originSessionID,
        `🔁 **PBA \`${loopId}\`** — auditor disapproved (attempt ${s.attempt}/${s.maxAttempts}, ${verdict.findings.length} finding(s)${byText}). Sending findings back to the planner for revision.`,
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
