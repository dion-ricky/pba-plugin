// End-to-end smoke test of the PBA loop with a mocked plugin context.
// The plan phase runs in the origin (main) session: each scenario simulates
// it by executing `pba_plan_submit` as `ses_origin` after `startLoop` — which
// is also what kicks off the loop driver. Revision/resume re-plans are
// prompted to the origin session by the driver and dispatched to the mock
// script by role (via state.sessions, where sessions.plan === ses_origin).
// Simulates the role agents (including one auditor session per audit
// perspective) by invoking the registered submission tools exactly as real
// sessions would, then asserts the loop's state machine behavior: approval,
// revision, escalation, missing-submission retry, resume.
//
// Run: bun smoke-loop.ts
import { promises as fs } from "node:fs"
import * as state from "./state"
import { registerTools, type SessionLoopMap } from "./tools"
import { resolveConfig, resumeLoop, startLoop } from "./orchestrator"
import {
  HERDR_MAX_RATIO,
  HERDR_MIN_RATIO,
  planBalancedColumn,
  setHerdrRunnerForTests,
  type ColumnSplitPlan,
  type HerdrRunner,
} from "./herdr"

type ToolDef = {
  name: string
  execute: (args: unknown, context: unknown) => Promise<{ content: string }>
}

let failures = 0
function check(name: string, condition: boolean, detail = "") {
  if (!condition) {
    failures++
    console.error(`FAIL ${name} ${detail}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

const AGENT_TO_ROLE: Record<string, string> = {
  "pba-builder": "build",
  "pba-auditor": "audit",
}

interface MockScript {
  act: (
    role: string,
    sessionID: string,
    attempt: number,
    tools: Map<string, ToolDef>,
    sessions: Map<string, string>,
  ) => Promise<void>
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    agent: "mock",
    messageID: "msg_mock",
    id: "call_mock",
    progress: async () => {},
    signal: new AbortController().signal,
  }
}

function makeMockCtx(script: MockScript) {
  const tools = new Map<string, ToolDef>()
  const synthetics: string[] = []
  const sessionsByRole = new Map<string, string>()
  const createdModels: ({ id: string; providerID: string; variant?: string } | undefined)[] = []
  // Track in-flight tool executions so session.wait is realistic: a session
  // only "ends" after the submission tools it invoked have settled.
  let inFlight = 0
  let counter = 0
  const ctx = {
    session: {
      create: async (input: { agent?: string; model?: { id: string; providerID: string; variant?: string } }) => {
        const id = `ses_mock_${++counter}`
        const role = AGENT_TO_ROLE[input.agent ?? ""]
        if (role) sessionsByRole.set(role, id)
        createdModels.push(input.model)
        return { id }
      },
      switchModel: async () => {},
      // Role resolution mirrors production: session IDs are recorded in state
      // (sessions.plan / sessions.build / sessions["audit:<perspective>"]).
      prompt: async (input: { sessionID: string; text: string }) => {
        const s = await state.readState(currentLoopDir!)
        const entry = Object.entries(s.sessions).find(([, id]) => id === input.sessionID)
        if (!entry) throw new Error(`mock: prompt for unknown session ${input.sessionID}`)
        const role = entry[0].startsWith("audit:") ? "audit" : entry[0]
        await script.act(role, input.sessionID, s.attempt, tools, sessionsByRole)
      },
      wait: async () => {
        while (inFlight > 0) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      },
      get: async (input: { sessionID: string }) => {
        // The origin session reports the model its user picked in the TUI/CLI.
        if (input.sessionID === "ses_origin") {
          return { outcome: "succeeded", model: { providerID: "mock", id: "mock-main", variant: "high" } }
        }
        return { outcome: "succeeded" }
      },
      synthetic: async (input: { text: string }) => {
        synthetics.push(input.text)
      },
    },
    tool: {
      transform: async (fn: (editor: { add: (t: ToolDef) => void; namespace: () => void }) => Promise<void>) => {
        await fn({
          add: (t) =>
            tools.set(t.name, {
              name: t.name,
              execute: async (args, context) => {
                inFlight++
                try {
                  return await t.execute(args, context)
                } finally {
                  inFlight--
                }
              },
            }),
          namespace: () => {},
        })
      },
    },
  }
  return { ctx, tools, synthetics, sessionsByRole, createdModels }
}

async function waitFor(loopDir: string, statuses: string[], timeoutMs = 3000): Promise<state.PbaState> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await state.readState(loopDir)
    if (statuses.includes(s.status)) return s
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${statuses.join("|")}; last status=${s.status} phase=${s.phase} error=${s.lastError}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The loop marks terminal state before announcing; wait for the announce too. */
async function waitForSynthetic(synthetics: string[], needle: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (synthetics.some((text) => text.includes(needle))) return
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for synthetic containing "${needle}"; got: ${synthetics.join(" // ")}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Simulate the main-session planner: execute `pba_plan_submit` as the given
 * session (the origin session on the fresh hand-off; the driver prompts the
 * same session again for revision re-plans).
 */
async function submitPlan(tools: Map<string, ToolDef>, sessionID: string) {
  const result = await tools.get("pba_plan_submit")!.execute(
    {
      plan: "# Plan\nDo the thing.\n\n## Tasks\n1. Do it",
      summary: "Do the thing",
      tasks: ["Do the thing in src/thing.ts"],
      acceptanceCriteria: ["src/thing.ts exists and does the thing"],
    },
    toolContext(sessionID),
  )
  return result.content
}

async function submitBuild(tools: Map<string, ToolDef>, sessions: Map<string, string>, attempt: number) {
  await tools.get("pba_build_complete")!.execute(
    { summary: `Build ${attempt}`, changedFiles: ["src/thing.ts"] },
    toolContext(sessions.get("build")!),
  )
}

type ScriptedVerdict = {
  verdict: "approved" | "disapproved"
  report: string
  findings: string[]
}

/** Resolve the audit perspective of an auditor session from state.sessions. */
function perspectiveOfSession(s: state.PbaState, sessionID: string): string | undefined {
  const entry = Object.entries(s.sessions).find(
    ([key, id]) => key.startsWith("audit:") && id === sessionID,
  )
  return entry?.[0].slice("audit:".length)
}

/** File one perspective verdict as the auditor session identified by sessionID. */
async function filePerspectiveVerdict(
  tools: Map<string, ToolDef>,
  sessionID: string,
  scripted: (perspective: string, attempt: number) => ScriptedVerdict,
) {
  const s = await state.readState(currentLoopDir!)
  const perspective = perspectiveOfSession(s, sessionID)
  if (!perspective) throw new Error(`mock: session ${sessionID} has no audit:<perspective> key in state`)
  await tools.get("pba_verdict")!.execute(
    { perspective, ...scripted(perspective, s.attempt) },
    toolContext(sessionID),
  )
}

function allApprove(perspective: string): ScriptedVerdict {
  return {
    verdict: "approved",
    report: `# Review (${perspective})\nAll criteria met from the ${perspective} perspective.`,
    findings: [],
  }
}

let currentLoopDir: string | null = null

function placeholderState() {
  return {
    version: 1 as const,
    title: "guard",
    spec: "s",
    originSessionID: "ses_origin",
    status: "active" as const,
    phase: "plan" as const,
    attempt: 1,
    maxAttempts: 3,
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
    createdAt: state.now(),
    updatedAt: state.now(),
  }
}

async function scenario(name: string, fn: (root: string) => Promise<void>) {
  console.log(`\n== ${name}`)
  const root = await fs.mkdtemp("/tmp/pba-loop-" + name + "-")
  try {
    await fn(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// -- 1. Approved on first attempt ------------------------------------------
await scenario("approve-first-attempt", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("status completed", final.status === "completed", final.status)
  check("phase done", final.phase === "done")
  check("one attempt", final.attempt === 1, String(final.attempt))
  check("one merged verdict", final.verdicts.length === 1 && final.verdicts[0].verdict === "approved")
  check("plan.md written", (await fs.readFile(`${currentLoopDir}/plan.md`, "utf8")).includes("Do the thing"))
  check("review.md written", (await fs.readFile(`${currentLoopDir}/review.md`, "utf8")).includes("Merged verdict"))
  check("changed files recorded", final.changedFiles[0] === "src/thing.ts")
  check("origin notified", mock.synthetics.some((t) => t.includes("completed")), mock.synthetics.join(" // "))
  check(
    "phase sessions inherit origin model (incl. variant)",
    mock.createdModels.length === 5 &&
      mock.createdModels.every((m) => m?.providerID === "mock" && m.id === "mock-main" && m.variant === "high"),
    JSON.stringify(mock.createdModels),
  )
})

// -- 1b. Explicit per-role model override beats the origin session's model ---
await scenario("explicit-model-override-wins", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, models: { audit: "gateway/audit-model" } })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("override scenario completes", final.status === "completed", final.status)
  const auditModels = mock.createdModels.slice(1)
  check(
    "builder inherits origin model, all perspective auditors use override",
    mock.createdModels.length === 5 &&
      mock.createdModels[0]?.id === "mock-main" &&
      mock.createdModels[0]?.variant === "high" &&
      auditModels.length === 4 &&
      auditModels.every((m) => m?.id === "audit-model" && m?.providerID === "gateway"),
    JSON.stringify(mock.createdModels),
  )
})

// -- 2. Disapproved once, then approved on revision --------------------------
await scenario("revision-then-approve", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") {
        await filePerspectiveVerdict(tools, sessionID, (p, at) =>
          at === 1 && p === "bugs"
            ? {
                verdict: "disapproved",
                report: `# Review (bugs)\nNot done.`,
                findings: ["1. Acceptance criterion 1 unmet: thing.ts missing the thing"],
              }
            : allApprove(p),
        )
      }
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("completed on attempt 2", final.status === "completed" && final.attempt === 2, `${final.status} attempt=${final.attempt}`)
  check("two merged verdicts recorded", final.verdicts.length === 2)
  check("attempt-1 merged findings prefixed with [bugs]", final.verdicts[0]?.findings.every((f) => f.startsWith("[bugs]")) === true, JSON.stringify(final.verdicts[0]?.findings))
  check("revision flag set", final.revision === true)
  check("findings flowed back", mock.synthetics.some((t) => t.includes("disapproved") && t.includes("1 finding") && t.includes("bugs")), mock.synthetics.join(" // "))
})

// -- 3. Escalation when the budget is exhausted ------------------------------
await scenario("escalate-at-max-attempts", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 2 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") {
        await filePerspectiveVerdict(tools, sessionID, (p) => ({
          verdict: "disapproved",
          report: `# Review (${p})\nStill bad.`,
          findings: ["1. Still broken"],
        }))
      }
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("escalated", final.status === "escalated", final.status)
  check("stopped at maxAttempts", final.attempt === 2 && final.maxAttempts === 2)
  check("lastError explains", (final.lastError ?? "").includes("exhausted"))
  await waitForSynthetic(mock.synthetics, "escalated")
  check("origin notified of escalation", true)
})

// -- 4. Orchestrated plan phase without a submission: one retry, then fail ---
// startLoop no longer drives anything; the orchestrated plan phase (which
// prompts the origin session) is triggered here via resumeLoop. The mock
// origin session submits nothing -> one retry -> failed.
await scenario("incomplete-phase-retry-then-fail", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async () => {
      /* the origin session never calls its submission tool */
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  await resumeLoop(mock.ctx as never, config, loopId, "ses_origin")
  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("failed", final.status === "failed", final.status)
  check(
    "error mentions missing submission",
    (final.lastError ?? "").includes("without calling its mandatory submission tool"),
    final.lastError ?? "",
  )
  await waitForSynthetic(mock.synthetics, "failed")
  check("origin notified of failure", true)
})

// -- 5. Resume a failed loop after fixing the underlying behavior ------------
await scenario("resume-recovers", async (root) => {
  let behave = false
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (!behave) return
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // First resume runs the orchestrated plan phase; the origin session
  // (behave = false) submits nothing -> one retry -> loop fails.
  await resumeLoop(mock.ctx as never, config, loopId, "ses_origin")
  await waitFor(currentLoopDir, ["failed"])

  behave = true
  // The failed loop's driver may still be finishing its cleanup; retry the
  // resume the way a real user would when told "already running".
  let message = ""
  const deadline = Date.now() + 3000
  for (;;) {
    message = await resumeLoop(mock.ctx as never, config, loopId, "ses_origin")
    if (!message.includes("already running")) break
    if (Date.now() > deadline) throw new Error(`resume kept reporting busy: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  check("resume reports phase", message.includes("resumed from phase"), message)
  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("resume completes the loop", final.status === "completed", `${final.status}: ${final.lastError ?? ""}`)
})

// -- 6. Tool phase guards reject out-of-order submissions --------------------
// Built with hand-written loop state (no background driver) so the checks are
// fully deterministic.
await scenario("tool-phase-guards", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({ act: async () => {} })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)

  const loopDir = state.loopDirOf(root, ".pba", "manual-guard-loop")
  await fs.mkdir(loopDir, { recursive: true })
  await state.writeState(loopDir, {
    ...placeholderState(),
    loopId: "manual-guard-loop",
  })
  const st = await state.readState(loopDir)
  void st

  // A plan already submitted for the current attempt is rejected (prevents a
  // double-submit racing the phase transition).
  await state.updateState(loopDir, (draft) => {
    draft.submission = { kind: "plan", at: new Date().toISOString() }
  })
  let doubleErr = ""
  try {
    await mock.tools.get("pba_plan_submit")!.execute(
      { plan: "p", summary: "s", tasks: ["t"], acceptanceCriteria: ["a"] },
      toolContext("ses_origin"),
    )
  } catch (cause) {
    doubleErr = (cause as Error).message
  }
  check("double plan submit rejected", doubleErr.includes("already submitted"), doubleErr)

  let verdictErr = ""
  try {
    await mock.tools.get("pba_verdict")!.execute({ verdict: "approved", report: "x", findings: [] }, toolContext("ses_unknown"))
  } catch (cause) {
    verdictErr = (cause as Error).message
  }
  check("unknown session rejected", verdictErr.includes("not part of any PBA loop"), verdictErr)

  let phaseErr = ""
  try {
    await mock.tools.get("pba_verdict")!.execute({ verdict: "approved", report: "x", findings: [] }, toolContext("ses_origin"))
  } catch (cause) {
    phaseErr = (cause as Error).message
  }
  check("wrong phase rejected", phaseErr.includes('phase "plan"'), phaseErr)

  let disapproveErr = ""
  try {
    await mock.tools.get("pba_verdict")!.execute(
      { verdict: "disapproved", report: "x", findings: [] },
      toolContext("ses_origin"),
    )
  } catch (cause) {
    disapproveErr = (cause as Error).message
  }
  check("disapproval without findings rejected", disapproveErr.includes("requires at least one"), disapproveErr)

  await state.updateState(loopDir, (draft) => {
    draft.status = "failed"
  })
  let closedErr = ""
  try {
    await mock.tools.get("pba_plan_submit")!.execute(
      { plan: "p", summary: "s", tasks: ["t"], acceptanceCriteria: ["a"] },
      toolContext("ses_origin"),
    )
  } catch (cause) {
    closedErr = (cause as Error).message
  }
  check("closed loop rejects submissions", closedErr.includes("is failed"), closedErr)
})

// -- 7. Invalid options fail fast --------------------------------------------
await scenario("config-validation", async (root) => {
  let err = ""
  try {
    resolveConfig(root, { maxAttempts: 0 })
  } catch (cause) {
    err = (cause as Error).message
  }
  check("maxAttempts validated", err.includes("positive integer"), err)

  err = ""
  try {
    resolveConfig(root, { models: { audit: "no-slash" } })
  } catch (cause) {
    err = (cause as Error).message
  }
  check("model ref validated", err.includes('must look like "provider/model"'), err)

  err = ""
  try {
    resolveConfig(root, { models: { plan: "any/thing" } } as never)
  } catch (cause) {
    err = (cause as Error).message
  }
  check(
    "models.plan rejected (planning runs in the main session)",
    err.includes("planning runs in the main session"),
    err,
  )

  err = ""
  try {
    resolveConfig(root, { auditPerspectives: [] })
  } catch (cause) {
    err = (cause as Error).message
  }
  check("empty auditPerspectives rejected", err.includes("auditPerspectives"), err)

  err = ""
  try {
    resolveConfig(root, { auditPerspectives: ["Bad Name!"] })
  } catch (cause) {
    err = (cause as Error).message
  }
  check("non-kebab-case perspective rejected", err.includes("auditPerspectives"), err)

  const defaults = resolveConfig(root, {})
  check(
    "default perspectives",
    JSON.stringify(defaults.auditPerspectives) === JSON.stringify(["spec-adherence", "bugs", "security", "code-quality"]),
    JSON.stringify(defaults.auditPerspectives),
  )

  err = ""
  try {
    resolveConfig(root, { control: "magic" } as never)
  } catch (cause) {
    err = (cause as Error).message
  }
  check("invalid control rejected", err.includes('options.control must be "subagent" or "herdr"'), err)

  err = ""
  try {
    resolveConfig(root, { control: "herdr", herdr: { ratio: 1 } })
  } catch (cause) {
    err = (cause as Error).message
  }
  check("herdr.ratio above 0.9 rejected", err.includes("options.herdr.ratio"), err)

  err = ""
  try {
    resolveConfig(root, { control: "herdr", herdr: { ratio: 0.05 } })
  } catch (cause) {
    err = (cause as Error).message
  }
  check("herdr.ratio below 0.1 rejected", err.includes("options.herdr.ratio"), err)

  check(
    "herdr.ratio accepts the inclusive [0.1, 0.9] bounds",
    [0.1, 0.5, 0.9].every(
      (ratio) => resolveConfig(root, { control: "herdr", herdr: { ratio } }).herdr.ratio === ratio,
    ),
  )

  err = ""
  try {
    resolveConfig(root, { control: "herdr", herdr: { promptTimeoutMs: 0 } })
  } catch (cause) {
    err = (cause as Error).message
  }
  check("herdr.promptTimeoutMs validated", err.includes("options.herdr.promptTimeoutMs"), err)

  const herdrDefaults = resolveConfig(root, {})
  check(
    "default control/herdr options",
    herdrDefaults.control === "subagent" &&
      herdrDefaults.herdr.ratio === 0.5 &&
      herdrDefaults.herdr.promptTimeoutMs === 600000,
    JSON.stringify(herdrDefaults),
  )
})

// -- 8. All perspective auditors approve: merged verdict completes the loop --
await scenario("all-perspectives-approve", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("loop completed", final.status === "completed", final.status)
  const auditKeys = Object.keys(final.sessions).filter((k) => k.startsWith("audit:")).sort()
  check(
    "session per perspective",
    auditKeys.join(",") === "audit:bugs,audit:code-quality,audit:security,audit:spec-adherence",
    auditKeys.join(","),
  )
  check("4 perspectiveVerdicts", final.perspectiveVerdicts?.length === 4, String(final.perspectiveVerdicts?.length))
  check("merged verdict approved", final.verdicts[0]?.verdict === "approved", JSON.stringify(final.verdicts))
  const review = await fs.readFile(`${currentLoopDir}/review.md`, "utf8")
  for (const p of ["spec-adherence", "bugs", "security", "code-quality"]) {
    check(`review.md has per-perspective section for ${p}`, review.includes(`## ${p}`))
    check(`review-${p}.md exists`, (await fs.readFile(`${currentLoopDir}/review-${p}.md`, "utf8")).includes(perspectiveOfSession(final, final.sessions[`audit:${p}`]!) ?? ""))
  }
})

// -- 9. One disapproving perspective sends [perspective]-prefixed findings back
await scenario("one-perspective-disapproves", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") {
        await filePerspectiveVerdict(tools, sessionID, (p, at) =>
          at === 1 && p === "security"
            ? {
                verdict: "disapproved",
                report: `# Review (security)\nUnsafe.`,
                findings: ["1. Unescaped shell interpolation in src/thing.ts"],
              }
            : allApprove(p),
        )
      }
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("completed on revision", final.status === "completed" && final.attempt === 2, `${final.status} attempt=${final.attempt}`)
  check(
    "attempt-1 merged verdict disapproved with [security] finding",
    final.verdicts[0]?.verdict === "disapproved" &&
      final.verdicts[0]?.findings.length === 1 &&
      final.verdicts[0]?.findings[0].startsWith("[security] "),
    JSON.stringify(final.verdicts[0]?.findings),
  )
  check("8 perspectiveVerdicts across 2 attempts", final.perspectiveVerdicts?.length === 8, String(final.perspectiveVerdicts?.length))
  await waitForSynthetic(mock.synthetics, "disapproved")
  check("planner announcement mentions disapproval", true)
})

// -- 10. Missing perspective verdict: retried, only missing session respawned -
await scenario("missing-perspective-verdict-retried", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const auditSessionsSeen: string[] = []
  let skippedOnce = false
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") {
        const s = await state.readState(currentLoopDir!)
        const perspective = perspectiveOfSession(s, sessionID)!
        auditSessionsSeen.push(perspective)
        if (perspective === "security" && !skippedOnce) {
          skippedOnce = true
          return // security auditor never files its verdict on the first pass
        }
        await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
      }
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("completed after retry", final.status === "completed", `${final.status}: ${final.lastError ?? ""}`)
  const counts: Record<string, number> = {}
  for (const p of auditSessionsSeen) counts[p] = (counts[p] ?? 0) + 1
  check("filed perspectives spawned exactly once", ["spec-adherence", "bugs", "code-quality"].every((p) => counts[p] === 1), JSON.stringify(counts))
  check("missing perspective re-spawned", counts["security"] === 2, JSON.stringify(counts))
  check("4 perspectiveVerdicts", final.perspectiveVerdicts?.length === 4, String(final.perspectiveVerdicts?.length))
})

// -- 11. Concurrent pba_verdict calls: no lost perspective verdicts ----------
await scenario("concurrent-verdicts-not-lost", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") {
        // Interleave the parallel verdict submissions before the state
        // read-modify-write so the per-loop mutex is actually exercised.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20))
        await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
      }
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("completed", final.status === "completed", `${final.status}: ${final.lastError ?? ""}`)
  check("all 4 concurrent verdicts recorded", final.perspectiveVerdicts?.length === 4, JSON.stringify(final.perspectiveVerdicts?.map((v) => v.perspective)))
  const perspectives = new Set(final.perspectiveVerdicts?.map((v) => v.perspective) ?? [])
  check(
    "each perspective recorded exactly once",
    ["spec-adherence", "bugs", "security", "code-quality"].every((p) => perspectives.has(p)),
    JSON.stringify([...perspectives]),
  )
})

// -- 12. Stray legacy verdict (no perspective) rejected in a parallel loop ---
await scenario("stray-legacy-verdict-rejected-in-parallel-audit", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessionID)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") {
        const s = await state.readState(currentLoopDir!)
        const perspective = perspectiveOfSession(s, sessionID)!
        if (perspective === "bugs" && attempt === 1) {
          // One perspective auditor misbehaves: calls pba_verdict WITHOUT
          // the perspective argument before filing its real verdict.
          try {
            await tools.get("pba_verdict")!.execute(
              { verdict: "approved", report: "# stray legacy verdict", findings: [] },
              toolContext(sessionID),
            )
            check("legacy verdict rejected in parallel loop", false, "no error thrown")
          } catch (cause) {
            check(
              "legacy verdict rejected in parallel loop",
              String((cause as Error).message).includes("perspective"),
              String((cause as Error).message),
            )
          }
        }
        await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
      }
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  // Simulate the main-session planner: submitting the plan kicks the driver.
  await submitPlan(mock.tools, "ses_origin")

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("loop completed despite stray legacy call", final.status === "completed", `${final.status}: ${final.lastError ?? ""}`)
  check("4 perspectiveVerdicts (none lost)", final.perspectiveVerdicts?.length === 4, String(final.perspectiveVerdicts?.length))
  check(
    "exactly one merged verdict for attempt 1, approved",
    final.verdicts.length === 1 && final.verdicts[0].attempt === 1 && final.verdicts[0].verdict === "approved",
    JSON.stringify(final.verdicts),
  )
  const review = await fs.readFile(`${currentLoopDir}/review.md`, "utf8")
  check("review.md has merged verdict header", review.includes("Merged verdict"))
  for (const p of ["spec-adherence", "bugs", "security", "code-quality"]) {
    check(`review.md has per-perspective section for ${p}`, review.includes(`## ${p}`))
    check(`review-${p}.md exists`, (await fs.readFile(`${currentLoopDir}/review-${p}.md`, "utf8")).includes(perspectiveOfSession(final, final.sessions[`audit:${p}`]!) ?? ""))
  }
})

// -- 13. herdr control path: happy path with a fake herdr CLI ---------------
// The fake runner encodes the CLI JSON shapes verified against herdr 0.9.5
// (see docs/herdr-agent-automation-plan.md and scripts/herdr-real-smoke.sh);
// the disk checks stay authoritative.

type HerdrCall = { args: string[] }

interface FakeHerdrOptions {
  /** Simulates the agent's turn when its prompt is delivered. */
  onPrompt?: (name: string, text: string) => Promise<void>
  /** stdout returned by `agent prompt --wait`; default: {"status":"done"}. */
  promptStdout?: (name: string, text: string) => string
  /** When it returns a message, the runner rejects with that message. */
  reject?: (args: string[]) => string | undefined
  /** Hook invoked when `pane close` is called (after the reject check). */
  onClose?: (paneId: string) => Promise<void>
  /**
   * Native session ID returned by `agent get` (real shape:
   * result.agent.agent_session.value). Return undefined to simulate the
   * real-world case where the TUI has no session until its first prompt.
   * Default: a unique ses_herdr_* id (session available immediately).
   */
  getSession?: (name: string) => string | undefined
  /** Omit the origin session's entry from `agent list` (anchor fallback tests). */
  omitOriginInAgentList?: boolean
  /**
   * Layout returned by `pane layout --pane <id>`. Return the layout object
   * directly; the fake wraps it as `{ result: { layout } }`. Default: an
   * equal-height column over every pane the fake has created.
   */
  layout?: (paneId: string) => unknown
}

function makeFakeHerdr(opts: FakeHerdrOptions = {}) {
  const calls: HerdrCall[] = []
  let paneSeq = 0
  let sessionSeq = 0
  // Started agents: name -> pane id (populated by `agent start`).
  const started = new Map<string, string>()
  const runner: HerdrRunner = async (_file, args) => {
    calls.push({ args })
    const rejection = opts.reject?.(args)
    if (rejection) throw new Error(rejection)
    const [sub, verb] = args
    if (sub === "--version") return { stdout: "herdr 0.9.5 (fake)", stderr: "" }
    if (sub === "agent" && verb === "list") {
      const agents: unknown[] = []
      if (!opts.omitOriginInAgentList) {
        agents.push({
          agent: "opencode",
          pane_id: "pane_origin",
          agent_session: { kind: "id", source: "herdr:opencode", value: "ses_origin" },
        })
      }
      for (const [name, pane] of started) {
        const entry: Record<string, unknown> = { agent: "opencode", name, pane_id: pane }
        const sid = opts.getSession?.(name)
        if (sid !== undefined) entry.agent_session = { kind: "id", source: "herdr:opencode", value: sid }
        agents.push(entry)
      }
      return { stdout: JSON.stringify({ result: { agents } }), stderr: "" }
    }
    if (sub === "pane" && verb === "split") {
      return {
        stdout: JSON.stringify({ result: { pane: { pane_id: `pane_${++paneSeq}` } } }),
        stderr: "",
      }
    }
    if (sub === "pane" && verb === "layout") {
      const paneFlag = args.indexOf("--pane")
      const paneId = paneFlag >= 0 ? args[paneFlag + 1] : ""
      const custom = opts.layout?.(paneId)
      if (custom !== undefined) return { stdout: JSON.stringify({ result: { layout: custom } }), stderr: "" }
      // Default: every pane the fake created, stacked in equal-height rows.
      const panes = Array.from({ length: paneSeq }, (_, i) => ({
        pane_id: `pane_${i + 1}`,
        rect: { x: 0, y: i * 10, width: 80, height: 10 },
      }))
      return { stdout: JSON.stringify({ result: { layout: { panes, splits: [] } } }), stderr: "" }
    }
    if (sub === "agent" && verb === "start") {
      const name = args[2]
      const paneFlag = args.indexOf("--pane")
      started.set(name, paneFlag >= 0 ? args[paneFlag + 1] : `pane_${++paneSeq}`)
      return { stdout: "", stderr: "" }
    }
    if (sub === "agent" && verb === "prompt") {
      const name = args[2]
      const text = args[3]
      await opts.onPrompt?.(name, text)
      return { stdout: opts.promptStdout?.(name, text) ?? JSON.stringify({ status: "done" }), stderr: "" }
    }
    if (sub === "agent" && verb === "read") {
      return {
        stdout: JSON.stringify({ result: { text: `pane contents of ${args[2]}: still working…` } }),
        stderr: "",
      }
    }
    if (sub === "agent" && verb === "get") {
      const sessionID = opts.getSession ? opts.getSession(args[2]) : `ses_herdr_${++sessionSeq}`
      // Real herdr 0.9.5 shape: session nested under result.agent.agent_session.
      const agent: Record<string, unknown> = { agent: "opencode", name: args[2] }
      if (sessionID !== undefined) agent.agent_session = { kind: "id", source: "herdr:opencode", value: sessionID }
      return { stdout: JSON.stringify({ result: { agent } }), stderr: "" }
    }
    if (sub === "pane" && verb === "close") {
      await opts.onClose?.(args[2])
      return { stdout: "", stderr: "" }
    }
    throw new Error(`fake herdr: unexpected call ${args.join(" ")}`)
  }
  return { calls, runner }
}

/** Resolve the role key + native session for a herdr agent name from state.herdrPanes. */
async function herdrRoleOf(
  loopDir: string,
  name: string,
): Promise<{ key: string; sessionID: string }> {
  const s = await state.readState(loopDir)
  const entry = Object.entries(s.herdrPanes ?? {}).find(([, p]) => p.agent === name)
  if (!entry) throw new Error(`fake herdr: no herdrPanes entry for agent "${name}"`)
  return { key: entry[0], sessionID: entry[1].nativeSessionID! }
}

/** Simulate a herdr-driven role agent doing its work: file the role's submission. */
function herdrSubmitter(tools: Map<string, ToolDef>) {
  return async (name: string) => {
    const s = await state.readState(currentLoopDir!)
    const { key, sessionID } = await herdrRoleOf(currentLoopDir!, name)
    if (key === "build") {
      await submitBuild(tools, new Map([["build", sessionID]]), s.attempt)
    } else if (key.startsWith("audit:")) {
      await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    } else {
      throw new Error(`fake herdr: unexpected role key "${key}"`)
    }
  }
}

// -- 12b. planBalancedColumn invariants + herdr rounding simulation ---------
/** Fraction of the column each leaf keeps, derived from the emitted steps. */
function columnLeafFractions(plan: ColumnSplitPlan): number[] {
  const frac = new Map<number, number>([[0, 1]])
  for (const step of plan.steps) {
    const f = frac.get(step.source) ?? 1
    frac.set(step.source, f * step.ratio)
    frac.set(step.creates, f * (1 - step.ratio))
  }
  return plan.leaves.map((slot) => frac.get(slot) ?? 1)
}

/** Leaf heights when herdr rounds each split to whole cells (Math.round). */
function simulateColumnHeights(plan: ColumnSplitPlan, areaHeight: number): number[] {
  const heights = new Map<number, number>([[0, areaHeight]])
  for (const step of plan.steps) {
    const h = heights.get(step.source) ?? areaHeight
    const first = Math.round(h * step.ratio)
    heights.set(step.source, first)
    heights.set(step.creates, h - first)
  }
  return plan.leaves.map((slot) => heights.get(slot) ?? 0)
}

{
  const shapeIssues: string[] = []
  const ratioIssues: string[] = []
  const productIssues: string[] = []
  const spreadIssues: string[] = []
  for (let n = 1; n <= 64; n++) {
    const plan = planBalancedColumn(n)
    if (plan.steps.length !== n - 1 || plan.leaves.length !== n) {
      shapeIssues.push(`n=${n} steps=${plan.steps.length} leaves=${plan.leaves.length}`)
    }
    for (const step of plan.steps) {
      if (step.ratio < HERDR_MIN_RATIO || step.ratio > HERDR_MAX_RATIO || step.ratio < 1 / 3) {
        ratioIssues.push(`n=${n} ratio=${step.ratio}`)
      }
    }
    for (const fraction of columnLeafFractions(plan)) {
      if (Math.abs(fraction - 1 / n) > 1e-9) productIssues.push(`n=${n} fraction=${fraction}`)
    }
    for (const areaHeight of [66, 24, 120]) {
      const heights = simulateColumnHeights(plan, areaHeight)
      const spread = Math.max(...heights) - Math.min(...heights)
      if (spread > 1) spreadIssues.push(`n=${n} h=${areaHeight} spread=${spread} [${heights.join(",")}]`)
    }
  }
  check(
    "planBalancedColumn: n-1 steps and n leaves for n in 1..64",
    shapeIssues.length === 0,
    shapeIssues.slice(0, 5).join("; "),
  )
  check(
    "planBalancedColumn: every split ratio in [1/3, 0.5] (inside herdr's [0.1, 0.9] clamp)",
    ratioIssues.length === 0,
    ratioIssues.slice(0, 5).join("; "),
  )
  check(
    "planBalancedColumn: every leaf keeps exactly 1/n of the column",
    productIssues.length === 0,
    productIssues.slice(0, 5).join("; "),
  )
  check(
    "planBalancedColumn: rounded leaf-height spread <= 1 at heights 66/24/120",
    spreadIssues.length === 0,
    spreadIssues.slice(0, 5).join("; "),
  )
}

// -- 13. herdr control path: happy path with a fake herdr CLI runner --------
await scenario("herdr-happy-path", async (root) => {
  const prevEnv = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = "pane_origin"
  try {
    const config = resolveConfig(root, {
      stateDir: ".pba",
      maxAttempts: 3,
      control: "herdr",
      herdr: { ratio: 0.5, promptTimeoutMs: 600000 },
    })
    const mock = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const closeAfterSubmission: boolean[] = []
    const fake = makeFakeHerdr({
      onPrompt: herdrSubmitter(mock.tools),
      onClose: async () => {
        const events = await fs.readFile(`${currentLoopDir!}/events.jsonl`, "utf8")
        closeAfterSubmission.push(events.includes('"event":"phase.submitted"'))
      },
    })
    setHerdrRunnerForTests(fake.runner)
    const sessionLoops: SessionLoopMap = new Map()
    await registerTools(mock.ctx as never, config, sessionLoops)
    const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
    currentLoopDir = state.loopDirOf(root, ".pba", loopId)

    // Simulate the main-session planner: submitting the plan kicks the driver.
    await submitPlan(mock.tools, "ses_origin")

    const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"], 5000)
    check("herdr loop completed", final.status === "completed", `${final.status}: ${final.lastError ?? ""}`)

    const calls = fake.calls
    const positions = (sub: string, verb: string) =>
      calls.map((c, i) => (c.args[0] === sub && c.args[1] === verb ? i : -1)).filter((i) => i >= 0)
    const splits = positions("pane", "split")
    const starts = positions("agent", "start")
    const closes = positions("pane", "close")
    const rightSplits = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "split" && c.args.includes("right"))
    const downSplits = calls.filter((c) => c.args[0] === "pane" && c.args[1] === "split" && c.args.includes("down"))
    const auditStarts = calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start" && c.args[2].includes("-audit-"))
    const lastDownSplit = calls.indexOf(downSplits[downSplits.length - 1])
    const firstAuditStart = calls.indexOf(auditStarts[0])
    check(
      "5 pane splits (2 right + 3 down); audit panes created before any audit agent start",
      splits.length === 5 && starts.length === 5 && rightSplits.length === 2 &&
        downSplits.length === 3 && lastDownSplit < firstAuditStart,
      JSON.stringify(calls.map((c) => c.args.slice(0, 2).join(" "))),
    )
    const ratioOf = (c: HerdrCall) => parseFloat(c.args[c.args.indexOf("--ratio") + 1])
    check(
      "auditor column right of the origin pane, rows from the balanced split tree (all ratio 0.5)",
      rightSplits.every((c) => c.args[2] === "pane_origin") &&
        downSplits.length === 3 &&
        downSplits[0]?.args[2] === "pane_2" && Math.abs(ratioOf(downSplits[0]) - 0.5) < 1e-9 &&
        downSplits[1]?.args[2] === "pane_2" && Math.abs(ratioOf(downSplits[1]) - 0.5) < 1e-9 &&
        downSplits[2]?.args[2] === "pane_3" && Math.abs(ratioOf(downSplits[2]) - 0.5) < 1e-9,
      JSON.stringify([...rightSplits, ...downSplits].map((c) => c.args.slice(2))),
    )
    const paneOfAuditStart = (slug: string) => {
      const start = auditStarts.find((c) => c.args[2].includes(slug))
      const flag = start ? start.args.indexOf("--pane") : -1
      return flag >= 0 ? start!.args[flag + 1] : undefined
    }
    // planBalancedColumn(4).leaves === [0, 2, 1, 3]; slot 0 is the column pane
    // (pane_2), so the expected perspective order is pane_2, pane_4, pane_3, pane_5.
    const expectedPanes = planBalancedColumn(4).leaves.map((slot) => `pane_${slot + 2}`)
    check(
      "audit perspective-to-pane mapping equals planBalancedColumn(4).leaves in order",
      paneOfAuditStart("audit-spec") === expectedPanes[0] &&
        paneOfAuditStart("audit-bugs") === expectedPanes[1] &&
        paneOfAuditStart("audit-secu") === expectedPanes[2] &&
        paneOfAuditStart("audit-code") === expectedPanes[3] &&
        expectedPanes.join(",") === "pane_2,pane_4,pane_3,pane_5",
      JSON.stringify(auditStarts.map((c) => c.args.slice(2))),
    )
    const buildStart = calls.find((c) => c.args[0] === "agent" && c.args[1] === "start" && c.args[2].includes("-build-a1"))
    check(
      "builder agent start resumes the pre-created session (-s) with --auto, no --agent/--model flags",
      buildStart !== undefined &&
        buildStart.args.includes("-s") &&
        buildStart.args.includes("--auto") &&
        !buildStart.args.includes("--agent") &&
        !buildStart.args.includes("--model") &&
        buildStart.args[buildStart.args.indexOf("-s") + 1] === final.sessions.build,
      JSON.stringify(buildStart?.args),
    )
    check(
      "builder session created with the origin model (incl. variant)",
      mock.createdModels.some((m) => m?.providerID === "mock" && m.id === "mock-main" && m.variant === "high"),
      JSON.stringify(mock.createdModels),
    )
    const buildPrompt = calls.find((c) => c.args[0] === "agent" && c.args[1] === "prompt" && c.args[2].includes("-build-a1"))
    check(
      "builder phase prompt delivered with --wait flags",
      buildPrompt !== undefined &&
        buildPrompt.args[3].includes("You are the BUILDER phase") &&
        buildPrompt.args.includes("--wait") &&
        buildPrompt.args.includes("idle") &&
        buildPrompt.args.includes("done"),
      JSON.stringify(buildPrompt?.args.slice(0, 6)),
    )
    check(
      "panes closed only after the build submission reached disk",
      closes.length === 5 && closeAfterSubmission.length === 5 && closeAfterSubmission.every(Boolean),
      JSON.stringify(closeAfterSubmission),
    )
    check(
      "all herdr agent names satisfy the herdr 0.9.5 name rule (letter start, [a-z0-9-_], 1-32 chars)",
      starts.length === 5 &&
        calls
          .filter((c) => c.args[0] === "agent" && c.args[1] === "start")
          .every((c) => /^pba-[a-z][a-z0-9-_]{0,31}$/.test(c.args[2]) && c.args[2].length <= 32),
      JSON.stringify(calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start").map((c) => c.args[2])),
    )
    check(
      "herdrPanes recorded for build (paneId, agent, native session)",
      final.herdrPanes?.build !== undefined &&
        final.herdrPanes.build.paneId.startsWith("pane_") &&
        /^pba-build-a1-[0-9a-f]{8}$/.test(final.herdrPanes.build.agent) &&
        final.herdrPanes.build.nativeSessionID === final.sessions.build,
      JSON.stringify(final.herdrPanes?.build),
    )
    check(
      "sessions map role keys to native session IDs",
      final.sessions.build === final.herdrPanes?.build?.nativeSessionID &&
        ["spec-adherence", "bugs", "security", "code-quality"].every(
          (p) => final.herdrPanes?.[`audit:${p}`]?.nativeSessionID === final.sessions[`audit:${p}`],
        ),
      JSON.stringify(final.sessions),
    )
    const happyEvents = await fs.readFile(`${currentLoopDir}/events.jsonl`, "utf8")
    check(
      "equal default layout appends no layout.unequal event",
      !happyEvents.includes('"event":"layout.unequal"'),
      happyEvents,
    )
  } finally {
    setHerdrRunnerForTests()
    if (prevEnv === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = prevEnv
  }
})

// -- 13b. herdr: unequal audit column warns (layout.unequal) but completes --
await scenario("herdr-unequal-column-warns", async (root) => {
  const prevEnv = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = "pane_origin"
  try {
    const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, control: "herdr" })
    const mock = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const fake = makeFakeHerdr({
      onPrompt: herdrSubmitter(mock.tools),
      // The audit leaves (pane_2, pane_4, pane_3, pane_5) report a 2-row spread.
      layout: () => ({
        panes: [
          { pane_id: "pane_1", rect: { x: 0, y: 0, width: 40, height: 66 } },
          { pane_id: "pane_2", rect: { x: 40, y: 0, width: 40, height: 16 } },
          { pane_id: "pane_4", rect: { x: 40, y: 16, width: 40, height: 18 } },
          { pane_id: "pane_3", rect: { x: 40, y: 34, width: 40, height: 16 } },
          { pane_id: "pane_5", rect: { x: 40, y: 50, width: 40, height: 16 } },
        ],
        splits: [],
      }),
    })
    setHerdrRunnerForTests(fake.runner)
    const sessionLoops: SessionLoopMap = new Map()
    await registerTools(mock.ctx as never, config, sessionLoops)
    const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
    currentLoopDir = state.loopDirOf(root, ".pba", loopId)

    await submitPlan(mock.tools, "ses_origin")

    const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"], 5000)
    check(
      "loop still completes despite an unequal audit column",
      final.status === "completed",
      `${final.status}: ${final.lastError ?? ""}`,
    )
    const events = await fs.readFile(`${currentLoopDir}/events.jsonl`, "utf8")
    check(
      "layout.unequal event appended when the audit column spread is >= 2",
      events.includes('"event":"layout.unequal"'),
      events,
    )
  } finally {
    setHerdrRunnerForTests()
    if (prevEnv === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = prevEnv
  }
})

// -- 14. herdr: timed-out prompt -> one retry, agent read before the retry ---
await scenario("herdr-timeout-prompt-retry", async (root) => {
  const prevEnv = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = "pane_origin"
  try {
    const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, control: "herdr" })
    const fake = makeFakeHerdr({
      promptStdout: () => JSON.stringify({ status: "timeout" }),
      // The builder never files its submission: the loop must fail.
    })
    setHerdrRunnerForTests(fake.runner)
    const mock = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const sessionLoops: SessionLoopMap = new Map()
    await registerTools(mock.ctx as never, config, sessionLoops)
    const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
    currentLoopDir = state.loopDirOf(root, ".pba", loopId)

    await submitPlan(mock.tools, "ses_origin")

    const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"], 5000)
    check("herdr timeout loop failed", final.status === "failed", final.status)
    check("exactly one phase retry", final.phaseRetries === 1, String(final.phaseRetries))
    check(
      "missing-submission error",
      (final.lastError ?? "").includes("without calling its mandatory submission tool"),
      final.lastError ?? "",
    )
    const positions = (sub: string, verb: string) =>
      fake.calls.map((c, i) => (c.args[0] === sub && c.args[1] === verb ? i : -1)).filter((i) => i >= 0)
    const reads = positions("agent", "read")
    const prompts = positions("agent", "prompt")
    check(
      "agent read logged before the retry prompt",
      reads.length >= 1 && prompts.length === 2 && reads[0] < prompts[1],
      JSON.stringify(fake.calls.map((c) => c.args.slice(0, 2).join(" "))),
    )
  } finally {
    setHerdrRunnerForTests()
    if (prevEnv === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = prevEnv
  }
})

// -- 15. herdr: blocked prompt announces to the origin, then retry completes -
await scenario("herdr-blocked-prompt-announces", async (root) => {
  const prevEnv = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = "pane_origin"
  try {
    const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, control: "herdr" })
    let promptCount = 0
    const mock = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const submit = herdrSubmitter(mock.tools)
    const fake = makeFakeHerdr({
      onPrompt: async (name) => {
        promptCount++
        if (promptCount === 1) return // first attempt: builder sits blocked
        await submit(name)
      },
      promptStdout: () => (promptCount === 1 ? JSON.stringify({ status: "blocked" }) : JSON.stringify({ status: "done" })),
    })
    setHerdrRunnerForTests(fake.runner)
    const sessionLoops: SessionLoopMap = new Map()
    await registerTools(mock.ctx as never, config, sessionLoops)
    const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
    currentLoopDir = state.loopDirOf(root, ".pba", loopId)

    await submitPlan(mock.tools, "ses_origin")

    const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"], 5000)
    check("herdr blocked-then-retry loop completed", final.status === "completed", `${final.status}: ${final.lastError ?? ""}`)
    await waitForSynthetic(mock.synthetics, "blocked")
    check("origin announced about the blocked pane", true)
    const events = await fs.readFile(`${currentLoopDir}/events.jsonl`, "utf8")
    check("exactly one phase retry event", events.split('"event":"phase.retry"').length - 1 === 1)
  } finally {
    setHerdrRunnerForTests()
    if (prevEnv === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = prevEnv
  }
})

// -- 16. herdr: pane close throwing is cosmetic, the loop still completes ----
await scenario("herdr-pane-close-throw-is-non-fatal", async (root) => {
  const prevEnv = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = "pane_origin"
  try {
    const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, control: "herdr" })
    const mock = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const fake = makeFakeHerdr({
      onPrompt: herdrSubmitter(mock.tools),
      reject: (args) => (args[0] === "pane" && args[1] === "close" ? "pane close failed (fake)" : undefined),
    })
    setHerdrRunnerForTests(fake.runner)
    const sessionLoops: SessionLoopMap = new Map()
    await registerTools(mock.ctx as never, config, sessionLoops)
    const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
    currentLoopDir = state.loopDirOf(root, ".pba", loopId)

    await submitPlan(mock.tools, "ses_origin")

    const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"], 5000)
    check("loop completes despite throwing pane close", final.status === "completed", `${final.status}: ${final.lastError ?? ""}`)
  } finally {
    setHerdrRunnerForTests()
    if (prevEnv === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = prevEnv
  }
})

// -- 17. herdr: failing availability precheck fails the loop loudly ----------
await scenario("herdr-precheck-failure", async (root) => {
  const prevEnv = process.env.HERDR_PANE_ID
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, control: "herdr" })
  try {
    // Case 1: OpenCode not running inside herdr (origin session absent from
    // `agent list`, HERDR_PANE_ID unset).
    delete process.env.HERDR_PANE_ID
    const fakeNoEnv = makeFakeHerdr({ omitOriginInAgentList: true })
    setHerdrRunnerForTests(fakeNoEnv.runner)
    const mock1 = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const sessionLoops1: SessionLoopMap = new Map()
    await registerTools(mock1.ctx as never, config, sessionLoops1)
    const loopId1 = await startLoop(mock1.ctx as never, config, { spec: "Loop one", originSessionID: "ses_origin" })
    const loopDir1 = state.loopDirOf(root, ".pba", loopId1)
    await submitPlan(mock1.tools, "ses_origin")
    const final1 = await waitFor(loopDir1, ["completed", "failed", "escalated"], 5000)
    check("precheck failure fails the loop", final1.status === "failed", final1.status)
    check(
      "error names HERDR_PANE_ID and is actionable",
      (final1.lastError ?? "").includes("HERDR_PANE_ID") && (final1.lastError ?? "").includes("herdr agent list"),
      final1.lastError ?? "",
    )
    check(
      "no pane split / agent start was issued (no silent fallback)",
      fakeNoEnv.calls.every(
        (c) =>
          c.args[0] !== "pane" &&
          !(c.args[0] === "agent" && (c.args[1] === "start" || c.args[1] === "prompt")),
      ),
      JSON.stringify(fakeNoEnv.calls.map((c) => c.args.slice(0, 2).join(" "))),
    )

    // Case 2: herdr CLI unavailable (runner reports the binary missing).
    process.env.HERDR_PANE_ID = "pane_origin"
    const fakeNoCli = makeFakeHerdr({ reject: (args) => (args[0] === "--version" ? "herdr: command not found" : undefined) })
    setHerdrRunnerForTests(fakeNoCli.runner)
    const mock2 = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const sessionLoops2: SessionLoopMap = new Map()
    await registerTools(mock2.ctx as never, config, sessionLoops2)
    const loopId2 = await startLoop(mock2.ctx as never, config, { spec: "Loop two", originSessionID: "ses_origin" })
    const loopDir2 = state.loopDirOf(root, ".pba", loopId2)
    await submitPlan(mock2.tools, "ses_origin")
    const final2 = await waitFor(loopDir2, ["completed", "failed", "escalated"], 5000)
    check("CLI-unavailable failure fails the loop", final2.status === "failed", final2.status)
    check(
      "error names the herdr CLI requirement",
      (final2.lastError ?? "").includes("herdr CLI"),
      final2.lastError ?? "",
    )
    check(
      "no pane split / agent start was issued",
      fakeNoCli.calls.every((c) => c.args[0] !== "pane" && c.args[0] !== "agent"),
      JSON.stringify(fakeNoCli.calls.map((c) => c.args.slice(0, 2).join(" "))),
    )
  } finally {
    setHerdrRunnerForTests()
    if (prevEnv === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = prevEnv
  }
})

// -- 18. herdr: anchor pane resolved by session identity, env only a fallback -
// The plugin host's HERDR_PANE_ID can be stale or point at another workspace
// (the plugin runs in the opencode server process), so splits must anchor to
// the pane the origin session's TUI actually runs in.
await scenario("herdr-anchor-pane-resolution", async (root) => {
  const prevEnv = process.env.HERDR_PANE_ID
  try {
    const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, control: "herdr" })

    // Case 1: identity wins — env points at a foreign pane, agent list knows
    // the origin session's real pane.
    process.env.HERDR_PANE_ID = "pane_elsewhere"
    const mock1 = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const fake1 = makeFakeHerdr({ onPrompt: herdrSubmitter(mock1.tools) })
    setHerdrRunnerForTests(fake1.runner)
    const sessionLoops1: SessionLoopMap = new Map()
    await registerTools(mock1.ctx as never, config, sessionLoops1)
    const loopId1 = await startLoop(mock1.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
    const loopDir1 = state.loopDirOf(root, ".pba", loopId1)
    currentLoopDir = loopDir1
    await submitPlan(mock1.tools, "ses_origin")
    const final1 = await waitFor(loopDir1, ["completed", "failed", "escalated"], 5000)
    check("identity-anchored loop completed", final1.status === "completed", `${final1.status}: ${final1.lastError ?? ""}`)
    const split1 = fake1.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")
    check(
      "builder split anchored to the origin session's pane (never --current, never the stale env pane)",
      split1 !== undefined &&
        split1.args[2] === "pane_origin" &&
        !split1.args.includes("--current") &&
        !split1.args.includes("pane_elsewhere"),
      JSON.stringify(split1?.args),
    )

    // Case 2: fallback — origin session not in `agent list`, stale env pane
    // used with a loud warning.
    const mock2 = makeMockCtx({
      act: async (role, sessionID, _attempt, tools) => {
        if (role === "plan") await submitPlan(tools, sessionID)
      },
    })
    const fake2 = makeFakeHerdr({ onPrompt: herdrSubmitter(mock2.tools), omitOriginInAgentList: true })
    setHerdrRunnerForTests(fake2.runner)
    const sessionLoops2: SessionLoopMap = new Map()
    await registerTools(mock2.ctx as never, config, sessionLoops2)
    const loopId2 = await startLoop(mock2.ctx as never, config, { spec: "Do the thing again", originSessionID: "ses_origin" })
    const loopDir2 = state.loopDirOf(root, ".pba", loopId2)
    currentLoopDir = loopDir2
    await submitPlan(mock2.tools, "ses_origin")
    const final2 = await waitFor(loopDir2, ["completed", "failed", "escalated"], 5000)
    check("env-fallback loop completed", final2.status === "completed", `${final2.status}: ${final2.lastError ?? ""}`)
    const split2 = fake2.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")
    check(
      "fallback split uses HERDR_PANE_ID when the origin session is not in agent list",
      split2 !== undefined && split2.args[2] === "pane_elsewhere" && !split2.args.includes("--current"),
      JSON.stringify(split2?.args),
    )
  } finally {
    setHerdrRunnerForTests()
    if (prevEnv === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = prevEnv
  }
})

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log("\nALL LOOP TESTS PASSED")
