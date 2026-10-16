// Smoke test for the PBA state store. Run: bun smoke-state.ts
import { promises as fs } from "node:fs"
import * as state from "./state"

const root = await fs.mkdtemp("/tmp/pba-state-test-")
let failures = 0
function check(name: string, condition: boolean, detail = "") {
  if (!condition) {
    failures++
    console.error(`FAIL ${name} ${detail}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

// loopId creation: unique, slug, sortable-ish
const a = state.makeLoopId("Add Auth to API!")
const b = state.makeLoopId("Add Auth to API!")
check("loopId format", /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}-add-auth-to-api-[a-z0-9]{4}$/.test(a), a)
check("loopId uniqueness", a !== b)

// write/read/update roundtrip
const loopDir = state.loopDirOf(root, ".pba", a)
await fs.mkdir(loopDir, { recursive: true })
const initial = {
  version: 1 as const,
  loopId: a,
  title: "t",
  spec: "s",
  originSessionID: "ses_x",
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
await state.writeState(loopDir, initial)
const read = await state.readState(loopDir)
check("readback", read.loopId === a && read.status === "active")

// no tmp files left behind
const files = await fs.readdir(loopDir)
check("no tmp leftovers", files.every((f) => !f.includes(".tmp-")), files.join(","))

// update mutates and persists
await state.updateState(loopDir, (draft) => {
  draft.phase = "build"
  draft.attempt = 2
})
const after = await readStateShim()
async function readStateShim() {
  return state.readState(loopDir)
}
check("update persisted", after.phase === "build" && after.attempt === 2)

// corrupt state.json fails loudly
await fs.writeFile(`${loopDir}/state.json`, "{not json", "utf8")
let threw = ""
try {
  await state.readState(loopDir)
} catch (cause) {
  threw = (cause as Error).message
}
check("corrupt state throws", threw.includes("not valid JSON"), threw)

// validateState catches missing fields
let missingFields = ""
try {
  state.validateState({ loopId: "x" })
} catch (cause) {
  missingFields = (cause as Error).message
}
check("validateState missing fields", missingFields.includes("missing required fields"), missingFields)

// scan + index across multiple loops, skipping junk
await fs.writeFile(`${loopDir}/state.json`, JSON.stringify({ ...initial, phase: "build", attempt: 2 }), "utf8")
// Distinct title so the loopIds differ beyond the random suffix, making the
// newest-first sort assertion deterministic even within the same millisecond.
const otherId = state.makeLoopId("Zebra migration")
const otherDir = state.loopDirOf(root, ".pba", otherId)
await fs.mkdir(otherDir, { recursive: true })
await fs.writeFile(
  `${otherDir}/state.json`,
  JSON.stringify({ ...initial, loopId: otherId, status: "completed", phase: "done", originSessionID: "ses_other" }),
  "utf8",
)
// junk that the scan must skip: dotfile dir, plain file, and an unparseable loop dir
await fs.mkdir(`${root}/.pba/.garbage`, { recursive: true })
await fs.writeFile(`${root}/.pba/notes.txt`, "ignore me", "utf8")
const corruptDir = `${root}/.pba/9999-01-01-000000-corrupt-zzzz`
await fs.mkdir(corruptDir, { recursive: true })
await fs.writeFile(`${corruptDir}/state.json`, "{not json", "utf8")

const loops = await state.loadAllLoops(root, ".pba")
check("scan finds 2 valid loops", loops.length === 2, `found ${loops.length}: ${loops.map((l) => l.state.loopId).join(",")}`)
check("scan sorts newest first", loops[0].state.loopId === otherId, loops[0].state.loopId)
const bySession = state.findLoopBySession(loops, "ses_x")
check("session lookup", bySession?.state.loopId === a)

await state.rebuildIndex(root, ".pba")
const index = JSON.parse(await fs.readFile(`${root}/.pba/index.json`, "utf8"))
check("index rebuilt", index.loops.length === 2 && index.loops.some((l: { loopId: string }) => l.loopId === otherId))

// invalid loopId rejected
let badId = ""
try {
  state.loopDirOf(root, ".pba", "../escape")
} catch (cause) {
  badId = (cause as Error).message
}
check("loopId traversal rejected", badId.includes("invalid loopId"), badId)

await fs.rm(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log("\nALL STATE TESTS PASSED")
