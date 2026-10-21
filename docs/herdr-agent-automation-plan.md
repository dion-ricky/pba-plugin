# Plan: herdr as the Agent Automation Layer for the PBA Plugin

Status: Phase 1 implemented (opt-in `control: "herdr"` via the `herdr.ts`
adapter + orchestrator control path; verified by fake-runner smoke tests in
`smoke-loop.ts`). Phase 0 (spike) is a **manual, user-run precondition** — it
requires installing herdr and interactively running OpenCode TUIs, and must
pass before any live `control: "herdr"` run. Phase 2 is out of scope for this
build.
Researched: 2026-10-20 against herdr 0.9.5 docs (herdr.dev) and OpenCode V2 CLI

## Summary

Replace the plugin's subagent/child-session spawning (`ctx.session.create` +
`ctx.session.prompt`/`wait`) with full-fledged OpenCode TUI sessions launched
and controlled through [herdr](https://herdr.dev). Each role session gets its
own herdr pane next to the user's main session, driven via the herdr CLI. The
loop's state machine, submission tools, and on-disk state are unchanged.

## Why

- Role sessions become **live, watchable panes**: the user sees the builder
  and each auditor working in real time instead of an invisible child session.
- **Done notifications**: herdr detects the full-screen OpenCode TUI lifecycle
  (working / idle / blocked) and fires its done chime / notification per pane.
  Verified during research: `opencode run` and `opencode mini` do NOT report
  agent state to herdr (they don't match the detection manifest), so full TUI
  sessions are required for chimes.
- **Persistence and remote access**: phase sessions live in herdr and can be
  inspected/attached from anywhere herdr can reach, independent of the
  terminal that started the loop.
- Future option: same driver can launch other agent kinds (`--kind claude`,
  `codex`, …) for builder/auditor roles.

## Current architecture (what stays)

- Loop state machine in `orchestrator.ts`: plan → build → audit, retries,
  escalation. **Unchanged.**
- Submission tools (`pba_plan_submit`, `pba_build_complete`, `pba_verdict`)
  in `tools.ts` — the loop's real completion signal is the submission marker
  in `.pba/<loopId>/state.json`. **Unchanged.**
- Role→session mapping via `findLoopBySession` / `state.sessions`. Kept, but
  the session IDs now come from herdr-reported native session identity (see
  Session identity below).
- Planner runs in the origin (main) session — no pane, no herdr involvement.

Key insight that makes this low-risk: herdr's lifecycle detection is only a
*gate* ("is the turn over?"). The loop's truth is on disk. A flaky herdr wait
degrades into the existing `PhaseIncomplete` retry path, not a broken loop.

## Target design

### Pane layout and lifecycle

When the loop spawns a role session, it splits panes off the pane the main
OpenCode session runs in (`--current` resolves via `HERDR_PANE_ID`):

```
Build phase:        Audit phase:            After each verdict:   Loop end:
 --- ---            --- ---                 --- ---               --- ---
| 1 | 2 |          | 1 | b |  (builder      | 1 | a2 |            | 1 |
 --- ---            --- ---   closed)       |---|                 ---
      ↓ close 2     | 1 | a1 |               | 1 | a3 |
      (builder      | 1 |----|               |---|
      submitted)    | 1 | a2 |               | 1 |
                    --- ---                 --- ---
```

1. Builder: `herdr pane split --current --direction right --ratio 0.5 --no-focus`
2. Auditors: the first auditor right-splits the **origin pane** (opening the
   audit column), then the column is carved into equal rows by a **balanced
   binary split tree** (`planBalancedColumn`): a group of `k` rows splits into
   `k1=⌊k/2⌋` and `k2=⌈k/2⌉` at `ratio = k1/k`, recursing. Every ratio lands
   in `[1/3, 0.5]`, so herdr's `--ratio` clamp to `[0.1, 0.9]` never bites and
   each leaf keeps `1/n` of the column (within herdr's 1-row rounding). The old
   linear `1/(n-i+1)` chain was rejected: for large `n` its first ratios fell
   below `0.1` and were silently clamped, over-allocating the top rows and
   starving the tail. Never anchor to the builder pane — it was closed after
   the build submission, and closed herdr panes are gone (`pane_not_found`),
   not back-at-a-prompt shells. After the column is built the orchestrator
   reads `herdr pane layout` back and appends a `layout.unequal` event if the
   leaf heights differ by more than the 1-row rounding.
3. All panes created **before** any `agent start` (an available shell pane at
   its prompt is required for `agent start`).
4. Close-on-done, only after the disk-state check passes:
   - builder pane → `herdr pane close <id>` once the build submission is
     recorded in `state.json`
   - each auditor pane → closed progressively as its perspective verdict
     lands
   - every close is wrapped in try/catch and treated as cosmetic; a failed
     close never fails the loop
5. Closing a pane kills its opencode process and REMOVES the pane (the
   split collapses; the pane ID no longer exists). The *session* survives on
   the shared background service and stays reachable via `opencode -s
   <sessionID>`.
6. Revision loops re-anchor to the origin pane: it is the only pane
   guaranteed alive for the whole loop, so every split (builder retry and
   auditors alike) anchors there.

### Control flow per role session (replaces `spawnPhaseSession` + prompt/wait)

```bash
# 1. Anchor pane: resolve the pane the origin session's TUI actually runs in,
#    by identity — `herdr agent list` reports every opencode instance's
#    native session + pane. Never trust the plugin host's HERDR_PANE_ID (the
#    plugin runs in the opencode server process; its env pane can be stale or
#    in another workspace).
origin_pane=$(herdr agent list | jq -r --arg s "$ORIGIN_SESSION_ID" \
  '.result.agents[] | select(.agent_session.value == $s) | .pane_id')

# 2. Layout: split the origin pane explicitly (herdr 0.9.5 supports
#    --no-focus on `pane split`; direction is right|down only)
pane_id=$(herdr pane split "$origin_pane" --direction right --ratio 0.5 --no-focus | jq -r '.result.pane.pane_id')

# 3. Pre-create the role session via the server API with its agent + model
#    (the TUI has no --agent/--model flags; Model.Ref = {id, providerID, variant?})
session_id=$(opencode api post /api/session -d '{"title":"PBA <loopId> · build (attempt 1)","agent":"pba-builder","model":{"id":"…","providerID":"…","variant":"…"}}' | jq -r '.data.id')

# 4. Start the full TUI resuming that session (-s) with auto-approvals
herdr agent start pba-build-a1-3f2a9c1d --kind opencode --pane "$pane_id" \
  -- -s "$session_id" --auto

# 5. Deliver the phase prompt and wait for the turn to settle
herdr agent prompt pba-build-a1-3f2a9c1d "<phase prompt>" --wait --until idle --until done --timeout 600000

# 6. Verify the submission on disk (existing logic)
#    state.json submission.kind === "build" etc.
```

- Step 3's wait is a gate only; step 4 remains authoritative.
- Failure handling: `agent_blocked` (permission/question UI) → announce to
  the origin session and stop waiting for that pane; `timeout` /
  `agent_prompt_stalled` → read the pane (`agent read`) before any retry so a
  prompt is never submitted twice; then fall into the existing
  `PhaseIncomplete` retry.
- Parallel auditors: one pane + one `agent prompt --wait` per perspective,
  driven concurrently (the existing `Promise.all` in `runAuditPhase`).

### Session identity (role enforcement)

`tools.ts` maps the calling session ID to a loop via `state.sessions`. With
herdr, the orchestrator **pre-creates the role session via the server API**
(`ctx.session.create`, the same call the subagent path uses) with the role's
agent and resolved model, so the session ID is known before the pane exists
and is recorded into `state.sessions[role]` and `state.herdrPanes` right at
spawn. The TUI is then started with `-s <sessionID> --auto`. Verified against
opencode 2.0.32: the TUI has no `--agent`/`--model` flags; `-s` resumes a
session with its stored agent/model/variant (confirmed: a session created
with agent "plan" stayed on that agent through a TUI resume + turn).

### Verified against herdr 0.9.5 + opencode 2.0.32 (2026-10-20, live)

- `herdr pane split` supports `--no-focus` and `--ratio`; `--direction`
  accepts `right` and `down` only.
- `--ratio` is the fraction the **source** pane keeps and is **clamped to
  `[0.1, 0.9]`**: requesting `0.05` stores `0.1`, requesting `0.95` stores
  `0.9` (verified live). The balanced column tree stays in `[1/3, 0.5]`, far
  from either bound, so its ratios are never clamped.
- `herdr agent start` has **no** `--no-focus` option (`--kind`, `--pane`,
  `--timeout` only); passing it fails with `unknown option`.
- Agent names must be 1-32 chars of `[a-z0-9-_]` starting with a letter;
  anything else is rejected with `invalid_agent_name`.
- opencode's TUI rejects `--agent`/`--model` ("Unrecognized flag"); `mini`
  has both flags but is a different (minimal) interface — rejected in favor
  of pre-created sessions.
- `POST /api/session` accepts `agent` and `model` (`{id, providerID,
  variant?}`); `POST /api/session/{id}/model` and `/agent` exist for
  post-create changes.
- Resuming a pre-created session with `-s <id>` runs the TUI on that
  session's agent/model, and herdr's integration then reports exactly that
  session ID (`result.agent.agent_session.value`) — identity match with
  `state.sessions`.
- **Never set `parentID` on herdr role sessions**: resuming a child session
  makes the TUI open on its Subagents tab (empty) instead of the composer
  (observed live). Create them top-level; only the subagent path uses
  `parentID`.
- On opencode 2.0.32 the `agents` config key in `opencode.jsonc` does not
  register agents (only file-based `agents/*.md` load — 64 of them live,
  none from config keys). `pba-builder`/`pba-auditor` therefore fall back to
  the built-in `build` agent in herdr panes; model + variant still apply
  from the session. File-based agents (`.opencode/agents/*.md`) are the
  working alternative if role agents are wanted in panes.
- **Never anchor splits to `--current`** from the plugin: `--current` resolves
  via the calling process's `HERDR_PANE_ID`, and the plugin runs in the
  opencode server process — its env pane can be stale or belong to another
  workspace, putting the split in the wrong window (observed live). Resolve
  the origin session's pane via `herdr agent list` instead.
- `agent list` reports every detected agent with `pane_id`, `cwd`, and
  `agent_session.value` — the session→pane reverse lookup the anchor needs.

To re-verify your installed herdr end-to-end (spawns a real throwaway
opencode TUI pane, then closes it):

```bash
bash scripts/herdr-real-smoke.sh
```

Run it from inside a herdr pane (it needs `HERDR_PANE_ID`).

### Session / model wiring

- **Implemented (reverses the original spike-era decision)**: pre-create the
  role session via `ctx.session.create` (agent + resolved model) and attach
  with `opencode -s <id> --auto`. The original rejection relied on
  `--agent`/`--model` TUI flags, which opencode 2.0.32 does not have (live
  verified); herdr's detection and lifecycle tracking work fine when the TUI
  launches with `-s`. Model resolution keeps the existing precedence
  (per-role `models.build`/`models.audit` override > origin session's model,
  resolved via `ctx.session.get` and stored on the session, variant
  included).

### Configuration

New `opencode.json(c)` plugin option:

```jsonc
{
  "plugins": [{
    "package": ".opencode/plugins/pba",
    "options": {
      "control": "herdr",        // "subagent" (default) | "herdr"
      "herdr": {
        "ratio": 0.5,            // audit column width; range-limited to [0.1, 0.9]
        "promptTimeoutMs": 600000
      }
    }
  }]
}
```

- Default stays `"subagent"`: herdr is opt-in.
- If `control: "herdr"` and the `herdr` CLI is unavailable / `HERDR_PANE_ID`
  is not set (opencode not running inside herdr) → fail loudly at loop start
  with a clear message rather than silently degrading mid-loop.

## Phases

### Phase 0 — Spike (must pass before any code)

Status: **partially verified live against herdr 0.9.5 on 2026-10-20** (see
"Verified against herdr 0.9.5" above and `scripts/herdr-real-smoke.sh`).
Remaining manual checks are marked below.

1. Install herdr + `herdr integration install opencode`; run opencode inside
   a herdr pane; confirm done chime fires.
2. From a process inside a herdr pane (plugin context), confirm
   `herdr pane split --current` works via `HERDR_PANE_ID`.
3. `herdr agent start --kind opencode -- --agent pba-builder` in the pba
   repo → confirm the spawned TUI loads the project plugin and can call
   `pba_build_complete` (i.e. `pba_*` tools are registered server-side).
4. Confirm `herdr agent get` exposes `agent_session` (native session ID) for
   that pane — **verified**: reported at `result.agent.agent_session.value`,
   only after the first prompt — and that `--model provider/model#variant`
   is accepted (still unconfirmed).
5. Confirm pane topology behavior: repeated `down` splits against one parent
   stack as expected; `pane close` collapses the layout.

### Phase 1 — herdr driver behind the `control` flag

1. Add `herdr` adapter module (`herdr.ts`): typed wrappers for `pane split`,
   `agent start`, `agent prompt --wait`, `agent read`, `agent get`, `pane
   close`; JSON parsing, error mapping, safe shell quoting of prompts (temp
   file + `$(cat …)` interpolation; argv size is fine for multi-KB prompts).
2. `orchestrator.ts`: new `spawnPhaseSession`/prompt path used when
   `control === "herdr"`; record herdr pane ID + agent name + native session
   ID in `state.json` (new fields, additive only so old loops resume).
3. Close-on-done wiring in `runPhase` / `runPerspectiveAudit` (after the
   submission check, non-fatal).
4. Blocked-state announcements to the origin session.
5. Update `agents/pba-*.md` docs and `README.md`.

### Phase 2 — Polish (optional, after Phase 1 proves out)

- Reuse panes across attempts (no re-split on revision).
- herdr notifications for phase transitions (`herdr notification show`).
- Ratio/size tuning per perspective count; `pane resize` support.
- Consider other `--kind` values for cross-agent builder/auditor mixes.

## Risks / known trade-offs

- **Prompt delivery is keystrokes** (`agent prompt`, bracketed paste), not a
  typed API call. Mitigated by: disk-state authority, read-before-retry, and
  herdr's atomic paste handling. Watch for prompt corruption on very large
  plans during testing.
- **Lifecycle heuristics**: `unknown` states and "completion of that active
  turn may satisfy the wait" semantics; the disk check + retries absorb this.
- **New runtime dependency**: herdr installed, server running, main session
  inside herdr. Opt-in flag + loud failure keeps the default path safe.
- **Blocked sessions** (permission prompts) need human attention; herdr makes
  them visible (`blocked` state, chime) where child sessions stalled silently.
- herdr pane/agent IDs are scoped to one herdr server; loops don't survive
  herdr server restarts mid-phase (state.json still allows manual resume).

## Verification

- Smoke test (`smoke-loop.ts` extension): run a loop with `control: "herdr"`;
  assert pane topology matches the expected tree per phase, panes are closed
  after each phase, `state.json` records native session IDs, and a
  `PhaseIncomplete` injection triggers exactly one retry.
- Manual: verify chime fires per pane, layout collapse after build and after
  each verdict, `--auto`-less run surfaces `agent_blocked` announcement.
- Regression: default `control: "subagent"` path unchanged (existing smoke
  tests must pass untouched).
