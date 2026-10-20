# pba — plan-build-audit loop plugin for OpenCode V2

A supervised implementation loop: a **planner** turns your request into a
plan (in your own session — no planner subagent), a **builder** implements it
as a spawned subagent, and independent **auditor** subagents approve the
result or send findings back to the planner. The loop is driven entirely by
the plugin from persisted state — the models only file artifacts, they never
decide control flow.

```
spec ──► PLANNER ──► plan.md ──► BUILDER ──► changed files ──► AUDITORS (one per perspective, in parallel)
              ▲                                                       │
              └────────── disapproved + findings ◄────────────────────┘
                                            all approved ──► done (summary posted to your session)
```

## Repo layout

```
pba-plugin/
  index.ts            plugin entry: registers tools, commands, skill
  state.ts            coordination store (JSON + markdown; SQLite swap touches only this)
  orchestrator.ts     deterministic loop driver
  tools.ts            pba_start / pba_status / pba_state_read / submission tools
  commands.ts         /pba, /pba-status, /pba-resume
  prompts.ts          per-phase task prompts + skill content
  agents/             role agents (single source of truth; inlined into
                      project config by install.sh)
  install.sh          install into a target project
  smoke-state.ts      state store unit checks (bun)
  smoke-loop.ts       full loop state-machine test against a mocked context
```

## Usage

```text
/pba <spec>              start a loop, e.g. /pba add rate limiting to the API middleware
/pba-status [loopId]     show one loop or all loops in this repo
/pba-resume <loopId>     resume a paused/interrupted loop
```

Natural language works too: ask your primary agent to "run the PBA loop for
…" — the `pba-loop` skill teaches it to call the `pba_start` tool. Progress
and the final verdict are posted to your session as messages.

**Planning happens in your session**: after `pba_start` (or `/pba`), the
calling session itself is the planner — it investigates the codebase
read-only and submits the plan with `pba_plan_submit`. Only then does the
loop start the builder and auditor subagents in the background.

## Coordination state (per repo)

Everything lives under `.pba/` in the repo where the loop is started; each
loop gets its own directory (timestamp + slug + random suffix), so parallel
sessions never contend:

```
.pba/
  SKILL.md                    written by the plugin (skill source)
  index.json                  derived convenience index (rebuilt by scan)
  <loopId>/
    state.json                machine-readable loop state (atomic writes)
    plan.md                   current plan
    review.md                 latest audit report
    events.jsonl              append-only event log
```

Add `.pba/` to `.gitignore` — loop state is session-scoped, not source.
Swapping the JSON/markdown store for SQLite later only touches `state.ts`.

## Installation into another project

The plugin is project-local: nothing installs globally. From any machine with
the playground checkout and `node` on PATH:

```sh
# reference the plugin by path (recommended — one copy, all projects)
bash /path/to/pba-plugin/install.sh /path/to/project

# or vendor a copy into the project itself
bash /path/to/pba-plugin/install.sh /path/to/project --copy
```

The script reads the two `pba-*.md` agent definitions (single source of
truth), converts them to `agents` config entries, adds the plugin to `plugins`,
and writes or merges the target's `opencode.json(c)` — existing config is
backed up first, and an unparseable config aborts with a manual-merge snippet.
Re-running is safe (idempotent, no duplicate entries).

The equivalent config, if you prefer doing it by hand:

```jsonc
{
  "plugins": [{ "package": "/absolute/path/to/pba-plugin" }]
}
```
plus the two agents under `agents` (exactly what `install.sh` generates).

## Configuration (optional)

```jsonc title="opencode.jsonc"
{
  "plugins": [
    {
      "package": "./pba-plugin",
      "options": {
        "stateDir": ".pba",      // coordination dir, relative to the repo
        "maxAttempts": 3,        // disapprovals before the loop escalates to you
        "auditPerspectives": [   // audit phase: one parallel auditor per perspective
          "spec-adherence", "bugs", "security", "code-quality"
        ],
        "models": {              // optional per-role overrides ("provider/model")
          "build": "anthropic/claude-sonnet-4-5",
          "audit": "anthropic/claude-sonnet-4-5"
        }
        // no "plan" override: planning runs in the main session, which keeps
        // its own model (a stale "plan" key fails fast with a clear error)
      }
    }
  ]
}
```

The plugin auto-loads without config when vendored under `.opencode/plugins/`
or when installed via `install.sh` (which writes the `plugins` entry for you);
the options block is only needed to change defaults.

## Roles

The planner runs in **your session** (the one that called `pba_start` or
`/pba`) — it needs no agent definition because it keeps your session's own
permissions and model. The two subagent roles are markdown files in this
repo's `agents/` directory (`pba-builder`, `pba-auditor`); `install.sh`
converts them into the target project's `agents` config.

**Model selection** for spawned phase sessions, in priority order:

1. explicit `options.models.<role>` override (see Configuration), else
2. the origin session's selected model — variant included — so a loop started
   from a session running e.g. `ai-gateway/glm-5.3-flash#high` runs all
   spawned phases on exactly that model, else
3. OpenCode's configured default model.

The planner uses the main session's own model by definition.

| Role | Where it runs | Guardrails |
|---|---|---|
| planner (no agent) | your session, prompted in place by the loop | read-only discipline via the planner prompt; files `plan.md` via `pba_plan_submit` |
| `pba-builder` | spawned subagent session | implements the plan exactly, minimal diff, no commits |
| `pba-auditor` | spawned subagent session (one per perspective) | edit denied, `git diff/status/log/show` allowed |

Each role must finish with its mandatory structured submission tool
(`pba_plan_submit` / `pba_build_complete` / `pba_verdict`). Verdicts are
schema-validated: a disapproval requires specific findings; an approval
requires empty findings. The orchestrator retries a phase once if a session
ends without submitting, then fails the loop with a clear error.

### Parallel multi-perspective audit

The audit phase does not run a single auditor: it spawns **one auditor session
per perspective in parallel** (by default `spec-adherence`, `bugs`,
`security`, `code-quality`), each prompted to verify the build strictly through
its own lens with concrete evidence (file paths, line references, check
output) — an acceptance criterion an auditor cannot verify with evidence
counts as unmet. Each perspective auditor writes its own `review-<perspective>.md`
and files its own verdict. The orchestrator then merges the perspective
verdicts deterministically (no extra LLM step):

- the loop is **approved** only if *every* perspective approves;
- otherwise the disapproving perspectives' findings — each prefixed
  `[<perspective>]` — go back to the planner as one merged review.

Configure the set with the `auditPerspectives` option (a non-empty array of
kebab-case names); the `audit` model override applies to all perspective
sessions.

## Safety behavior

- **Escalation**: after `maxAttempts` disapprovals the loop stops with status
  `escalated` instead of looping forever; you get the findings and options.
- **Crash recovery**: every transition is persisted before the next session
  starts; `/pba-resume` continues from the incomplete phase.
- **Interruption**: if a phase session is interrupted, the loop pauses with
  the reason rather than advancing on missing work.
- **Parallel loops**: unique loop IDs and per-loop directories; the driver
  refuses to double-drive an already-running loop.

## Development

```sh
bun smoke-state.ts        # state store unit checks
bun smoke-loop.ts         # full loop state machine against a mocked context
```

Type-check against the real V2 API:

```sh
# from any dir with @opencode/plugin@2.x installed:
tsc --noEmit -p <tsconfig-with-paths-to-the-plugin>
```

## POC notes / next steps

- Storage is JSON + markdown per the POC design; the SQLite swap is isolated
  to `state.ts` (everything else goes through its functions).
- No cancel command yet — interrupt the active phase session and the loop
  pauses; then `/pba-resume` or let it fail out.
- Loop events (`events.jsonl`) are the basis for any future TUI/reporting.
