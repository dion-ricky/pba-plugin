// Command surface: /pba, /pba-status, /pba-resume.
//
// Commands return immediately; the loop itself runs in the background and
// posts progress to the invoking session via synthetic messages.

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import { resumeLoop, startLoop, statusReport, type LoopConfig } from "./orchestrator"
import type { SessionLoopMap } from "./tools"

async function notify(ctx: PluginContext, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.session.synthetic({ sessionID, text })
  } catch (cause) {
    console.error(`[pba] could not notify session ${sessionID}: ${(cause as Error).message}`)
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
          await notify(
            ctx,
            sessionID,
            `🔁 **PBA loop \`${loopId}\` started** — planner is working on: _${spec.slice(0, 120)}${spec.length > 120 ? "…" : ""}_\nProgress will be posted here. Check with \`/pba-status\`.`,
          )
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
