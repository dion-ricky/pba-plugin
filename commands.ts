// Command surface: /pba, /pba-status, /pba-resume.
//
// Commands return immediately; the loop itself runs in the background and
// posts progress to the invoking session via synthetic messages. The planner
// phase runs in the invoking (main) session: /pba hands the planner role to
// that session by prompting it with the planner hand-off.

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import { resumeLoop, startLoop, statusReport, type LoopConfig } from "./orchestrator"
import { loopDirOf, readState } from "./state"
import { plannerPrompt } from "./prompts"
import type { SessionLoopMap } from "./tools"

/**
 * Post a command reply (`/pba-status`, usage, errors) to a session WITHOUT
 * waking it: `session.synthetic` starts a turn unless `resume: false`, and a
 * status reply must not make the session's agent act again.
 */
async function notify(ctx: PluginContext, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.session.synthetic({ sessionID, text, resume: false })
  } catch (cause) {
    console.error(`[pba] could not notify session ${sessionID}: ${(cause as Error).message}`)
  }
}

/**
 * The single deliberately turn-starting message: the planner hand-off fallback.
 * `resume: true` must start a turn because the origin (main) session IS the
 * planner — it is used only when `session.prompt` could not deliver the
 * hand-off. Never use it for progress/status text.
 */
async function handOff(ctx: PluginContext, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.session.synthetic({ sessionID, text, resume: true })
  } catch (cause) {
    console.error(`[pba] could not hand off to session ${sessionID}: ${(cause as Error).message}`)
  }
}

export async function registerCommands(
  ctx: PluginContext,
  config: LoopConfig,
  sessionLoops: SessionLoopMap,
): Promise<void> {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "pba",
      description: "Start a plan-build-audit loop for a task: /pba <spec or task description>",
      execute: async ({ sessionID, prompt }) => {
        const spec = prompt.text?.trim() ?? ""
        if (spec.length === 0) {
          await notify(
            ctx,
            sessionID,
            "Usage: `/pba <spec>` — describe what to build or change. Example: `/pba add request rate limiting to the API middleware`.",
          )
          return
        }
        try {
          const loopId = await startLoop(ctx, config, { spec, originSessionID: sessionID })
          sessionLoops.set(sessionID, loopId)
          // Planning happens in this (main) session: prompt it with the
          // planner hand-off. If the prompt fails (e.g. session gone), fall
          // back to a synthetic notify with the instructions.
          const loopDir = loopDirOf(config.rootDir, config.stateDirName, loopId)
          const state = await readState(loopDir)
          const handoff =
            `🔁 **PBA loop \`${loopId}\` started** — planning happens in this session: _${spec.slice(0, 120)}${spec.length > 120 ? "…" : ""}_\n\n` +
            plannerPrompt(state, loopDir) +
            `\n\nCheck on the loop with /pba-status.`
          try {
            await ctx.session.prompt({ sessionID, text: handoff })
          } catch (cause) {
            console.error(`[pba] could not prompt session ${sessionID} with the planner hand-off: ${(cause as Error).message}`)
            await handOff(
              ctx,
              sessionID,
              `🔁 **PBA loop \`${loopId}\` started** — you are the PLANNER: call \`pba_state_read\`, investigate the codebase read-only, then submit the plan with \`pba_plan_submit\`. Planning happens in this session; no planner subagent is spawned.\nCheck with \`/pba-status\`.`,
            )
          }
        } catch (cause) {
          await notify(ctx, sessionID, `❌ Could not start PBA loop: ${(cause as Error).message}`)
        }
      },
    })

    editor.add({
      name: "pba-status",
      description: "Show PBA loop status: /pba-status [loopId]",
      execute: async ({ sessionID, prompt }) => {
        const loopId = prompt.text?.trim().split(/\s+/)[0] || undefined
        try {
          await notify(ctx, sessionID, await statusReport(config, loopId))
        } catch (cause) {
          await notify(ctx, sessionID, `❌ ${(cause as Error).message}`)
        }
      },
    })

    editor.add({
      name: "pba-resume",
      description: "Resume a paused or interrupted PBA loop: /pba-resume <loopId>",
      execute: async ({ sessionID, prompt }) => {
        const loopId = prompt.text?.trim().split(/\s+/)[0] ?? ""
        if (loopId.length === 0) {
          await notify(ctx, sessionID, "Usage: `/pba-resume <loopId>` — list loops with `/pba-status`.")
          return
        }
        try {
          const message = await resumeLoop(ctx, config, loopId, sessionID)
          await notify(ctx, sessionID, `🔁 ${message}`)
        } catch (cause) {
          await notify(ctx, sessionID, `❌ Could not resume loop \`${loopId}\`: ${(cause as Error).message}`)
        }
      },
    })
  })
}
