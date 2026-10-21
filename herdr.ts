// herdr CLI adapter for the PBA loop's opt-in `control: "herdr"` mode.
//
// When a loop is configured with control "herdr", role sessions run as full
// OpenCode TUIs in herdr panes instead of plugin child sessions (see
// docs/herdr-agent-automation-plan.md). This module is the ONLY place that
// knows about the herdr CLI: it wraps every command the orchestrator needs in
// typed functions, parses the JSON output shapes defensively (the Phase 0
// spike is a manual precondition and has not verified them yet), and maps
// failures to HerdrError.
//
// Security note: prompt text is never passed through a shell interpreter. The
// default runner execs the herdr binary with an argv array (execFile), so
// multi-KB phase prompts need no quoting or temp-file tricks.

import { execFile } from "node:child_process"

/**
 * Executes a herdr CLI invocation. The default implementation uses argv-array
 * execFile (never a composed shell string); tests inject a fake via
 * setHerdrRunnerForTests. A non-zero exit rejects (the default runner wraps
 * it in a HerdrError carrying stderr).
 */
export type HerdrRunner = (
  file: "herdr",
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

/** Typed failure of a herdr CLI call; stderr detail is preserved when available. */
export class HerdrError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(`[pba] ${message}`)
    this.name = "HerdrError"
  }
}

function defaultRunner(file: "herdr", args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new HerdrError(`herdr ${args.slice(0, 2).join(" ")} failed: ${(stderr || error.message).trim()}`, stderr))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

// Swap point for tests (smoke-loop.ts fakes the CLI); undefined resets to the
// real argv-array runner. Read at call time, never captured per client.
let activeRunner: HerdrRunner = defaultRunner

export function setHerdrRunnerForTests(runner?: HerdrRunner): void {
  activeRunner = runner ?? defaultRunner
}

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return activeRunner("herdr", args)
}

// -- Defensive parsing (CLI JSON shapes are unverified until the Phase 0 spike)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim())
  } catch {
    return undefined
  }
}

function digString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === "string" && current.length > 0 ? current : undefined
}

function digNumber(value: unknown, path: string[]): number | undefined {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Outcome of `herdr agent prompt --wait`. A gate only — the on-disk submission check decides. */
export type HerdrWaitOutcome = "done" | "blocked" | "timeout" | "stalled"

const WAIT_OUTCOME_PATTERNS: [HerdrWaitOutcome, RegExp][] = [
  ["blocked", /agent_blocked|\bblocked\b/],
  ["timeout", /\btimeout\b|\btimed[\s_-]?out\b/],
  ["stalled", /agent_prompt_stalled|\bstalled\b/],
  ["done", /\bdone\b|\bidle\b/],
]

function parseWaitOutcome(stdout: string): HerdrWaitOutcome {
  // Prefer a status-like field from the JSON payload; fall back to scanning
  // the raw text. Unknown shapes count as "done": the wait is a gate only,
  // the disk check is authoritative, and the existing retry absorbs flakiness.
  let text = stdout.trim()
  const parsed = parseJson(text)
  const status = typeof parsed === "string"
    ? parsed
    : digString(parsed, ["status"]) ?? digString(parsed, ["state"]) ?? digString(parsed, ["result"])
  if (status) text = status
  for (const [outcome, pattern] of WAIT_OUTCOME_PATTERNS) {
    if (pattern.test(text)) return outcome
  }
  return "done"
}

// -- Ratio clamp + balanced column planner

/**
 * herdr clamps `--ratio` to [0.1, 0.9] (verified live against herdr 0.9.5:
 * requesting 0.05 stores 0.1, requesting 0.95 stores 0.9). The balanced
 * column planner keeps every ratio in [1/3, 0.5], far from either bound, so
 * no split is silently clamped.
 */
export const HERDR_MIN_RATIO = 0.1
export const HERDR_MAX_RATIO = 0.9

/** One split of the balanced column plan. */
export interface ColumnSplitStep {
  /** Slot index of the pane being split. */
  source: number
  /** Fraction of the source pane the FIRST (top) child keeps: k1/k. */
  ratio: number
  /** Slot index assigned to the new (second/lower) child pane. */
  creates: number
}

export interface ColumnSplitPlan {
  /** Splits in execution order; slot 0 is the column pane. */
  steps: ColumnSplitStep[]
  /** Slot indices of the leaves, top-to-bottom. */
  leaves: number[]
}

/**
 * Plan a balanced binary split tree that carves one pane into `n` equal
 * stacked rows. A group of `k` rows is split into `k1=floor(k/2)` and
 * `k2=ceil(k/2)` at `ratio = k1/k`, which is always in [1/3, 0.5] — far from
 * herdr's [0.1, 0.9] `--ratio` clamp — and every leaf ends up with `1/n` of
 * the column (within herdr's 1-row rounding). DFS in-order (the first child
 * is recursed before the second) makes `leaves` top-to-bottom.
 */
export function planBalancedColumn(n: number): ColumnSplitPlan {
  if (!Number.isInteger(n) || n < 1) {
    throw new HerdrError(`planBalancedColumn needs a positive integer row count, got ${JSON.stringify(n)}`)
  }
  const steps: ColumnSplitStep[] = []
  const leaves: number[] = []
  let nextSlot = 1
  const visit = (slot: number, k: number): void => {
    if (k === 1) {
      leaves.push(slot)
      return
    }
    const k1 = Math.floor(k / 2)
    const creates = nextSlot++
    steps.push({ source: slot, ratio: k1 / k, creates })
    visit(slot, k1)
    visit(creates, k - k1)
  }
  visit(0, n)
  return { steps, leaves }
}

// -- Typed wrappers (one per herdr command the orchestrator needs)

export interface HerdrSplitOptions {
  direction: "right" | "down"
  /** Split size as a fraction of the source pane, in the open interval (0, 1). */
  ratio?: number
  noFocus?: boolean
  /**
   * Split this pane explicitly (positional PANE_ID) instead of `--current`.
   * Prefer this in the orchestrator: `--current` resolves via the calling
   * process's HERDR_PANE_ID, and the plugin host's env may point at a stale
   * or foreign pane (the split then lands in the wrong window/workspace).
   */
  sourcePaneId?: string
}

/**
 * Split a pane off a source pane (explicit `sourcePaneId`, or the current
 * pane resolved by herdr via HERDR_PANE_ID) and return the new pane's id.
 */
export async function herdrSplitPane(opts: HerdrSplitOptions): Promise<string> {
  const args = ["pane", "split"]
  if (opts.sourcePaneId) args.push(opts.sourcePaneId)
  else args.push("--current")
  args.push("--direction", opts.direction)
  if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio))
  if (opts.noFocus) args.push("--no-focus")
  const { stdout } = await run(args)
  const paneId = digString(parseJson(stdout), ["result", "pane", "pane_id"])
  if (!paneId) {
    throw new HerdrError(`herdr pane split returned no pane_id in its output: ${truncate(stdout)}`)
  }
  return paneId
}

/** One pane rectangle in the tab layout (`herdr pane layout`). */
export interface HerdrPaneRect {
  paneId?: string
  x?: number
  y?: number
  width?: number
  height?: number
}

/** One split node in the tab layout (`herdr pane layout`). */
export interface HerdrSplitRect {
  id?: string
  direction?: string
  ratio?: number
  rect?: { x?: number; y?: number; width?: number; height?: number }
}

export interface HerdrLayout {
  area?: { x?: number; y?: number; width?: number; height?: number }
  panes: HerdrPaneRect[]
  splits: HerdrSplitRect[]
}

function parseRect(value: unknown): { x?: number; y?: number; width?: number; height?: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return {
    x: digNumber(value, ["x"]),
    y: digNumber(value, ["y"]),
    width: digNumber(value, ["width"]),
    height: digNumber(value, ["height"]),
  }
}

/**
 * Read the tab layout herdr reports for a pane (`herdr pane layout --pane
 * <id>`). Returns the pane rectangles and split nodes with defensive parsing;
 * throws HerdrError when the payload is unparseable. Callers treat a failure
 * as cosmetic (the audit-column verifier never fails the loop).
 */
export async function herdrPaneLayout(opts: { paneId?: string } = {}): Promise<HerdrLayout> {
  const args = ["pane", "layout"]
  if (opts.paneId) args.push("--pane", opts.paneId)
  const { stdout } = await run(args)
  const parsed = parseJson(stdout)
  const layout = (parsed as { result?: { layout?: unknown } } | undefined)?.result?.layout
  if (typeof layout !== "object" || layout === null) {
    throw new HerdrError(`herdr pane layout returned no layout object: ${truncate(stdout)}`)
  }
  const rec = layout as Record<string, unknown>
  const panes: HerdrPaneRect[] = Array.isArray(rec["panes"])
    ? rec["panes"].map((raw) => {
        const p = raw as Record<string, unknown>
        const rect = (typeof p["rect"] === "object" && p["rect"] !== null ? p["rect"] : p) as unknown
        return {
          paneId: digString(p, ["pane_id"]) ?? digString(p, ["paneId"]),
          ...parseRect(rect),
        }
      })
    : []
  const splits: HerdrSplitRect[] = Array.isArray(rec["splits"])
    ? rec["splits"].map((raw) => {
        const s = raw as Record<string, unknown>
        return {
          id: digString(s, ["id"]),
          direction: digString(s, ["direction"]),
          ratio: digNumber(s, ["ratio"]),
          rect: parseRect(s["rect"]),
        }
      })
    : []
  return { area: parseRect(rec["area"]), panes, splits }
}

/**
 * Start a full OpenCode TUI in the given pane. extraArgs are passed through
 * after `--` (the orchestrator sends --agent and --model for role/model
 * selection at launch).
 */
export async function herdrAgentStart(name: string, paneId: string, extraArgs: string[]): Promise<void> {
  await run(["agent", "start", name, "--kind", "opencode", "--pane", paneId, "--", ...extraArgs])
}

/** Deliver the phase prompt and wait for the turn to settle. */
export async function herdrAgentPrompt(
  name: string,
  text: string,
  opts: { timeoutMs: number },
): Promise<HerdrWaitOutcome> {
  const { stdout } = await run([
    "agent",
    "prompt",
    name,
    text,
    "--wait",
    "--until",
    "idle",
    "--until",
    "done",
    "--timeout",
    String(opts.timeoutMs),
  ])
  return parseWaitOutcome(stdout)
}

/** Read the pane contents (used to log what an agent was doing after a timeout/stall). */
export async function herdrAgentRead(name: string): Promise<string> {
  const { stdout } = await run(["agent", "read", name])
  const parsed = parseJson(stdout)
  if (parsed === undefined) return stdout.trim()
  return digString(parsed, ["result", "text"]) ??
    digString(parsed, ["result", "content"]) ??
    digString(parsed, ["text"]) ??
    digString(parsed, ["content"]) ??
    stdout.trim()
}

/** Fetch an agent's identity; agentSession is the native OpenCode session ID when known.
 *
 * Real shape (herdr 0.9.5, opencode integration v13): the session is nested at
 * `result.agent.agent_session.value` and only appears after the agent created
 * a session (its first prompt) — an absent session is normal right after
 * `agent start`, not an error. Legacy shapes are kept as fallbacks.
 */
export async function herdrAgentGet(name: string): Promise<{ agentSession?: string }> {
  const { stdout } = await run(["agent", "get", name])
  const parsed = parseJson(stdout)
  const agentSession = digString(parsed, ["result", "agent", "agent_session", "value"]) ??
    digString(parsed, ["result", "agent_session", "value"]) ??
    digString(parsed, ["result", "agent_session", "id"]) ??
    digString(parsed, ["result", "agent_session", "session_id"]) ??
    digString(parsed, ["result", "agent_session"]) ??
    digString(parsed, ["agent_session", "id"]) ??
    digString(parsed, ["agent_session"])
  return { agentSession }
}

/** Close a pane (kills the TUI process; the session survives on the shared service). */
export async function herdrPaneClose(paneId: string): Promise<void> {
  await run(["pane", "close", paneId])
}

/** One entry of `herdr agent list`: an agent herdr currently sees. */
export interface HerdrAgentEntry {
  name?: string
  paneId?: string
  /** Native OpenCode session ID, when the integration has reported one. */
  agentSession?: string
  cwd?: string
}

/** List the agents herdr currently sees (native session + pane when reported). */
export async function herdrAgentList(): Promise<HerdrAgentEntry[]> {
  const { stdout } = await run(["agent", "list"])
  const parsed = parseJson(stdout) as { result?: { agents?: unknown[] } } | undefined
  const agents = parsed?.result?.agents
  if (!Array.isArray(agents)) return []
  return agents.map((raw) => {
    const rec = raw as Record<string, unknown>
    return {
      name: typeof rec["name"] === "string" ? rec["name"] : undefined,
      paneId: typeof rec["pane_id"] === "string" ? rec["pane_id"] : undefined,
      agentSession: digString(rec, ["agent_session", "value"]),
      cwd: typeof rec["cwd"] === "string" ? rec["cwd"] : undefined,
    }
  })
}

/**
 * Resolve the pane the origin session's TUI actually runs in, by identity:
 * `herdr agent list` reports every opencode instance's native session, so we
 * match on the session ID instead of trusting the plugin host's
 * HERDR_PANE_ID (which may be stale or point at another workspace — the
 * plugin runs in the opencode server process, not the user's TUI pane).
 * Falls back to HERDR_PANE_ID with a loud warning when the identity lookup
 * finds nothing; fails when neither is available.
 */
export async function resolveOriginPane(originSessionID: string): Promise<string> {
  const agents = await herdrAgentList().catch(() => [] as HerdrAgentEntry[])
  const self = agents.find((a) => a.agentSession === originSessionID && a.paneId)
  if (self?.paneId) return self.paneId
  if (process.env.HERDR_PANE_ID) {
    console.error(
      `[pba] could not find the origin session ${originSessionID} in \`herdr agent list\` — ` +
        `falling back to HERDR_PANE_ID=${process.env.HERDR_PANE_ID}. If the loop's panes appear in ` +
        "the wrong window/workspace, reinstall the herdr opencode integration (`herdr integration install opencode`).",
    )
    return process.env.HERDR_PANE_ID
  }
  throw new HerdrError(
    `could not locate the origin session ${originSessionID} in \`herdr agent list\`, and HERDR_PANE_ID is not set. ` +
      "Run OpenCode inside a herdr pane (with the opencode integration installed: `herdr integration install opencode`), " +
      "or remove the control option to use the default subagent mode.",
  )
}

/**
 * Fail loudly before any herdr-driven phase when the herdr CLI is
 * unreachable. Pane anchoring is resolved separately, by session identity
 * (resolveOriginPane) — never degrade to the subagent path silently.
 */
export async function herdrPrecheck(): Promise<void> {
  try {
    await run(["--version"])
  } catch (cause) {
    throw new HerdrError(`control "herdr" requires the herdr CLI on PATH: ${(cause as Error).message}`)
  }
}
