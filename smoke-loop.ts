// End-to-end smoke test of the PBA loop with a mocked plugin context.
// Simulates the three role agents by invoking the registered submission tools
// exactly as real sessions would, then asserts the loop's state machine
// behavior: approval, revision, escalation, missing-submission retry, resume.
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
  act: (role: string, attempt: number, tools: Map<string, ToolDef>, sessions: Map<string, string>) => Promise<void>
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
  let counter = 0
  const ctx = {
    session: {
      create: async (input: { agent?: string }) => {
        const id = `ses_mock_${++counter}`
        const role = AGENT_TO_ROLE[input.agent ?? ""]
        if (role) sessionsByRole.set(role, id)
        return { id }
      },
      switchModel: async () => {},
      prompt: async (input: { sessionID: string; text: string }) => {
        const role = [...sessionsByRole.entries()].find(([, id]) => id === input.sessionID)?.[0]
        if (!role) throw new Error(`mock: prompt for unknown session ${input.sessionID}`)
        const s = await state.readState(currentLoopDir!)
        await script.act(role, s.attempt, tools, sessionsByRole)
      },
      wait: async () => {},
      get: async () => ({ outcome: "succeeded" }),
      synthetic: async (input: { text: string }) => {
        synthetics.push(input.text)
      },
    },
    tool: {
      transform: async (fn: (editor: { add: (t: ToolDef) => void; namespace: () => void }) => Promise<void>) => {
        await fn({ add: (t) => tools.set(t.name, t), namespace: () => {} })
      },
    },
  }
  return { ctx, tools, synthetics, sessionsByRole }
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
  const root = await fs.mkdtemp(`/tmp/pba-loop-${name}-`)
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
    act: async (role, _attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") {
        await tools.get("pba_build_complete")!.execute(
          { summary: "Did the thing", changedFiles: ["src/thing.ts"] },
          toolContext(sessions.get("build")!),
        )
      }
      if (role === "audit") {
        await tools.get("pba_verdict")!.execute(
          { verdict: "approved", report: "# Review\nAll criteria met.", findings: [] },
          toolContext(sessions.get("audit")!),
        )
      }
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
  check("one verdict", final.verdicts.length === 1 && final.verdicts[0].verdict === "approved")
  check("plan.md written", (await fs.readFile(`${currentLoopDir}/plan.md`, "utf8")).includes("Do the thing"))
  check("review.md written", (await fs.readFile(`${currentLoopDir}/review.md`, "utf8")).includes("All criteria met"))
  check("changed files recorded", final.changedFiles[0] === "src/thing.ts")
  check("origin notified", mock.synthetics.some((t) => t.includes("completed")), mock.synthetics.join(" // "))
})

// -- 2. Disapproved once, then approved on revision --------------------------
await scenario("revision-then-approve", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") {
        await tools.get("pba_build_complete")!.execute(
          { summary: `Build ${attempt}`, changedFiles: ["src/thing.ts"] },
          toolContext(sessions.get("build")!),
        )
      }
      if (role === "audit") {
        await tools.get("pba_verdict")!.execute(
          attempt === 1
            ? { verdict: "disapproved", report: "# Review\nNot done.", findings: ["1. Acceptance criterion 1 unmet: thing.ts missing the thing"] }
            : { verdict: "approved", report: "# Review\nFixed.", findings: [] },
          toolContext(sessions.get("audit")!),
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
  check("two verdicts recorded", final.verdicts.length === 2)
  check("revision flag set", final.revision === true)
  check("findings flowed back", mock.synthetics.some((t) => t.includes("disapproved") && t.includes("1 finding")))
})

// -- 3. Escalation when the budget is exhausted ------------------------------
await scenario("escalate-at-max-attempts", async (root) => {
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 2 })
  const mock = makeMockCtx({
    act: async (role, _attempt, tools, sessions) => {
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") {
        await tools.get("pba_build_complete")!.execute(
          { summary: "Build", changedFiles: ["src/thing.ts"] },
          toolContext(sessions.get("build")!),
        )
      }
      if (role === "audit") {
        await tools.get("pba_verdict")!.execute(
          { verdict: "disapproved", report: "# Review\nStill bad.", findings: ["1. Still broken"] },
          toolContext(sessions.get("audit")!),
        )
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
  check("error mentions missing submission", (final.lastError ?? "").includes("without calling its mandatory submission tool"), final.lastError ?? "")
  await waitForSynthetic(mock.synthetics, "failed")
  check("origin notified of failure", true)
})

// -- 5. Resume a failed loop after fixing the underlying behavior ------------
await scenario("resume-recovers", async (root) => {
  let behave = false
  const config = resolveConfig(root, { stateDir: ".pba", maxAttempts: 3 })
  const mock = makeMockCtx({
    act: async (role, _attempt, tools, sessions) => {
      if (!behave) return
      if (role === "plan") await submitPlan(tools, sessions)
      if (role === "build") {
        await tools.get("pba_build_complete")!.execute(
          { summary: "Did the thing", changedFiles: ["src/thing.ts"] },
          toolContext(sessions.get("build")!),
        )
      }
      if (role === "audit") {
        await tools.get("pba_verdict")!.execute(
          { verdict: "approved", report: "# Review\nOK.", findings: [] },
          toolContext(sessions.get("audit")!),
        )
      }
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
})

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log("\nALL LOOP TESTS PASSED")
