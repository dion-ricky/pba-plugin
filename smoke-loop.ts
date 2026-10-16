// End-to-end smoke test of the PBA loop with a mocked plugin context.
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
  "pba-planner": "plan",
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

async function submitPlan(tools: Map<string, ToolDef>, sessions: Map<string, string>) {
  const result = await tools.get("pba_plan_submit")!.execute(
    {
      plan: "# Plan\nDo the thing.\n\n## Tasks\n1. Do it",
      summary: "Do the thing",
      tasks: ["Do the thing in src/thing.ts"],
      acceptanceCriteria: ["src/thing.ts exists and does the thing"],
    },
    toolContext(sessions.get("plan")!),
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
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

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
    mock.createdModels.length === 6 &&
      mock.createdModels.every((m) => m?.providerID === "mock" && m.id === "mock-main" && m.variant === "high"),
    JSON.stringify(mock.createdModels),
  )
})

// -- 1b. Explicit per-role model override beats the origin session's model ---
await scenario("explicit-model-override-wins", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3, models: { audit: "gateway/audit-model" } })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("override scenario completes", final.status === "completed", final.status)
  const auditModels = mock.createdModels.slice(2)
  check(
    "planner/builder inherit origin model, all perspective auditors use override",
    mock.createdModels.length === 6 &&
      mock.createdModels[0]?.id === "mock-main" &&
      mock.createdModels[0]?.variant === "high" &&
      mock.createdModels[1]?.id === "mock-main" &&
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
      if (role === "plan") await submitPlan(tools, sessions)
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
      if (role === "plan") await submitPlan(tools, sessions)
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

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("escalated", final.status === "escalated", final.status)
  check("stopped at maxAttempts", final.attempt === 2 && final.maxAttempts === 2)
  check("lastError explains", (final.lastError ?? "").includes("exhausted"))
  await waitForSynthetic(mock.synthetics, "escalated")
  check("origin notified of escalation", true)
})

// -- 4. Session ends without submitting: one retry, then fail ----------------
await scenario("incomplete-phase-retry-then-fail", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async () => {
      /* agent never calls its submission tool */
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

  const final = await waitFor(currentLoopDir, ["completed", "failed", "escalated"])
  check("failed", final.status === "failed", final.status)
  check(
    "error mentions missing submission",
    (final.lastError ?? "").includes("without calling its mandatory submission tool") ||
      (final.lastError ?? "").includes("without filing its perspective verdict"),
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
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)
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
})

// -- 8. All perspective auditors approve: merged verdict completes the loop --
await scenario("all-perspectives-approve", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, sessionID, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") await submitBuild(tools, sessions, attempt)
      if (role === "audit") await filePerspectiveVerdict(tools, sessionID, (p) => allApprove(p))
    },
  })
  const sessionLoops: SessionLoopMap = new Map()
  await registerTools(mock.ctx as never, config, sessionLoops)
  const loopId = await startLoop(mock.ctx as never, config, { spec: "Do the thing", originSessionID: "ses_origin" })
  currentLoopDir = state.loopDirOf(root, ".pba", loopId)

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
      if (role === "plan") await submitPlan(tools, sessions)
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
      if (role === "plan") await submitPlan(tools, sessions)
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
      if (role === "plan") await submitPlan(tools, sessions)
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
      if (role === "plan") await submitPlan(tools, sessions)
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

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log("\nALL LOOP TESTS PASSED")
