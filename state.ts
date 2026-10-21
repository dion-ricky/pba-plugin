// Coordination state for PBA (plan-build-audit) loops.
//
// All loop state lives under `<repo>/.pba/<loopId>/`:
//   state.json    machine-readable loop state (atomic writes)
//   plan.md       current plan (written by the planner via pba_plan_submit)
//   review.md     latest audit report (written by the auditor via pba_verdict)
//   events.jsonl  append-only event log
//
// Every loop owns its own directory, so parallel sessions never contend.
// index.json at the state root is derived and rebuilt by scan — it is a
// convenience, never a source of truth. Swap this module for SQLite later;
// nothing else should touch these files.

import { promises as fs } from "node:fs"
import path from "node:path"

export type PbaPhase = "plan" | "build" | "audit" | "done"
export type PbaStatus = "active" | "paused" | "completed" | "failed" | "escalated"
export type PbaRole = "plan" | "build" | "audit"
export type PbaVerdict = "approved" | "disapproved"
export type PbaSubmissionKind = "plan" | "build" | "verdict"

export interface VerdictRecord {
  attempt: number
  verdict: PbaVerdict
  findings: string[]
  report: string
  at: string
}

/** Verdict filed by one parallel perspective auditor for one attempt. */
export interface PerspectiveVerdictRecord {
  perspective: string
  attempt: number
  verdict: PbaVerdict
  findings: string[]
  report: string
  at: string
}

/**
 * Session map: the three role keys plus `audit:<perspective>` keys used by the
 * parallel perspective auditor sessions spawned during the audit phase.
 */
export type PbaSessions = Partial<Record<PbaRole, string>> & {
  [auditPerspective: `audit:${string}`]: string
}

/** herdr pane bookkeeping for one role session (only when a loop runs with control:"herdr"). */
export interface HerdrPaneRecord {
  paneId: string
  agent: string
  nativeSessionID?: string
}

export interface PbaState {
  version: 1
  loopId: string
  title: string
  spec: string
  originSessionID: string
  status: PbaStatus
  phase: PbaPhase
  /** 1-based build attempt; incremented after every disapproval. */
  attempt: number
  maxAttempts: number
  /** Retry budget for the current phase when a session ends without submitting. */
  phaseRetries: number
  revision: boolean
  sessions: PbaSessions
  /** Per-role-key herdr pane info when the loop runs with control:"herdr" (absent in subagent mode and older state files). */
  herdrPanes?: Record<string, HerdrPaneRecord>
  submission: { kind: PbaSubmissionKind; at: string } | null
  planSummary: string | null
  tasks: string[]
  acceptanceCriteria: string[]
  buildSummary: string | null
  changedFiles: string[]
  verdicts: VerdictRecord[]
  /** Per-perspective verdicts from the parallel audit phase (absent in older state files). */
  perspectiveVerdicts?: PerspectiveVerdictRecord[]
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export class StateError extends Error {
  constructor(message: string) {
    super(`[pba] ${message}`)
    this.name = "StateError"
  }
}

export function stateRoot(rootDir: string, stateDirName: string): string {
  return path.join(rootDir, stateDirName)
}

export function loopDirOf(rootDir: string, stateDirName: string, loopId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(loopId)) {
    throw new StateError(`invalid loopId "${loopId}"`)
  }
  return path.join(stateRoot(rootDir, stateDirName), loopId)
}

export function now(): string {
  return new Date().toISOString()
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
  return slug || "loop"
}

export function makeLoopId(title: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ts}-${slugify(title)}-${rand}`
}

/** Atomic JSON write: temp file + rename, so a crash never leaves torn state. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")
  await fs.rename(tmp, file)
}

export function validateState(value: unknown): PbaState {
  if (typeof value !== "object" || value === null) {
    throw new StateError("state.json is not an object")
  }
  const s = value as Record<string, unknown>
  const required = ["loopId", "status", "phase", "attempt", "createdAt", "updatedAt"]
  const missing = required.filter((key) => s[key] === undefined)
  if (missing.length > 0) {
    throw new StateError(`state.json is missing required fields: ${missing.join(", ")}`)
  }
  if (typeof s.attempt !== "number" || s.attempt < 1) {
    throw new StateError(`state.json has invalid attempt: ${JSON.stringify(s.attempt)}`)
  }
  return s as unknown as PbaState
}

export async function readState(loopDir: string): Promise<PbaState> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(loopDir, "state.json"), "utf8")
  } catch (cause) {
    throw new StateError(`cannot read state.json in ${loopDir}: ${(cause as Error).message}`)
  }
  try {
    return validateState(JSON.parse(raw))
  } catch (cause) {
    if (cause instanceof StateError) throw cause
    throw new StateError(`state.json in ${loopDir} is not valid JSON: ${(cause as Error).message}`)
  }
}

export async function writeState(loopDir: string, state: PbaState): Promise<PbaState> {
  const next = { ...state, updatedAt: now() }
  await writeJsonAtomic(path.join(loopDir, "state.json"), next)
  return next
}

/**
 * Read-modify-write helper. The closure mutates a fresh copy; it must not await.
 * Serialized per loop directory via an in-process async mutex: parallel
 * perspective auditor sessions (and their spawns) mutate the same state.json
 * concurrently, and interleaved read-modify-write cycles would lose records.
 */
const updateLocks = new Map<string, Promise<unknown>>()

export async function updateState(
  loopDir: string,
  mutate: (draft: PbaState) => void,
): Promise<PbaState> {
  const previous = updateLocks.get(loopDir) ?? Promise.resolve()
  const run = previous.then(async () => {
    const state = await readState(loopDir)
    const draft: PbaState = JSON.parse(JSON.stringify(state))
    mutate(draft)
    return writeState(loopDir, draft)
  })
  updateLocks.set(loopDir, run.then(() => undefined, () => undefined))
  return run
}

export async function writeArtifact(loopDir: string, filename: string, content: string): Promise<void> {
  const file = path.join(loopDir, filename)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmp, content.endsWith("\n") ? content : content + "\n", "utf8")
  await fs.rename(tmp, file)
}

export async function appendEvents(loopDir: string, entries: Record<string, unknown>[]): Promise<void> {
  if (entries.length === 0) return
  const at = now()
  const lines = entries.map((entry) => JSON.stringify({ at, ...entry })).join("\n") + "\n"
  await fs.appendFile(path.join(loopDir, "events.jsonl"), lines, "utf8")
}

export interface LoopRecord {
  loopDir: string
  state: PbaState
}

/** Scan all loop directories. Invalid entries are reported, never thrown. */
export async function loadAllLoops(rootDir: string, stateDirName: string): Promise<LoopRecord[]> {
  const root = stateRoot(rootDir, stateDirName)
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const records: LoopRecord[] = []
  const invalid: string[] = []
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "index.json") continue
    const loopDir = path.join(root, entry)
    try {
      const stat = await fs.stat(loopDir)
      if (!stat.isDirectory()) continue
      records.push({ loopDir, state: await readState(loopDir) })
    } catch (cause) {
      invalid.push(`${entry}: ${(cause as Error).message}`)
    }
  }
  if (invalid.length > 0) {
    console.error(`[pba] skipping unreadable loop directories: ${invalid.join("; ")}`)
  }
  records.sort((a, b) => {
    const ka = `${a.state.createdAt} ${a.state.loopId}`
    const kb = `${b.state.createdAt} ${b.state.loopId}`
    return ka < kb ? 1 : ka > kb ? -1 : 0
  })
  return records
}

/** Rebuild the derived index.json from a directory scan. */
export async function rebuildIndex(rootDir: string, stateDirName: string): Promise<void> {
  const loops = await loadAllLoops(rootDir, stateDirName)
  const index = {
    version: 1,
    rebuiltAt: now(),
    loops: loops.map(({ state }) => ({
      loopId: state.loopId,
      title: state.title,
      status: state.status,
      phase: state.phase,
      attempt: state.attempt,
      maxAttempts: state.maxAttempts,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    })),
  }
  await writeJsonAtomic(path.join(stateRoot(rootDir, stateDirName), "index.json"), index)
}

/** Find the loop a session belongs to (any role, including the origin session). */
export function findLoopBySession(
  loops: LoopRecord[],
  sessionID: string,
): LoopRecord | undefined {
  return loops.find(
    ({ state }) =>
      state.originSessionID === sessionID ||
      Object.values(state.sessions).some((id) => id === sessionID),
  )
}

export function latestVerdict(state: PbaState): VerdictRecord | undefined {
  return state.verdicts.length > 0 ? state.verdicts[state.verdicts.length - 1] : undefined
}

export function formatState(state: PbaState): string {
  const lines: string[] = []
  lines.push(`loopId: ${state.loopId}`)
  lines.push(`title: ${state.title}`)
  lines.push(`status: ${state.status} · phase: ${state.phase} · attempt ${state.attempt}/${state.maxAttempts}`)
  if (state.revision) lines.push("revision: yes (planner is addressing audit findings)")
  if (state.planSummary) lines.push(`plan summary: ${state.planSummary}`)
  if (state.buildSummary) lines.push(`build summary: ${state.buildSummary}`)
  if (state.changedFiles.length > 0) lines.push(`changed files: ${state.changedFiles.join(", ")}`)
  for (const v of state.verdicts) {
    lines.push(`verdict (attempt ${v.attempt}): ${v.verdict}${v.findings.length > 0 ? ` — ${v.findings.length} finding(s)` : ""}`)
  }
  for (const v of state.perspectiveVerdicts ?? []) {
    lines.push(`perspective verdict (attempt ${v.attempt}): ${v.perspective}: ${v.verdict}${v.findings.length > 0 ? ` — ${v.findings.length} finding(s)` : ""}`)
  }
  if (state.lastError) lines.push(`last error: ${state.lastError}`)
  lines.push(`updated: ${state.updatedAt}`)
  return lines.join("\n")
}
