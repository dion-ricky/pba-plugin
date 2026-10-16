// PBA — plan-build-audit loop plugin for OpenCode V2.
//
// What it registers:
//   Tools:     pba_start, pba_status, pba_state_read,
//              pba_plan_submit (planner), pba_build_complete (builder),
//              pba_verdict (auditor)
//   Commands:  /pba <spec>, /pba-status [loopId], /pba-resume <loopId>
//   Skill:     "pba-loop" so primary agents know how to trigger the loop
//              in natural language.
//
// The three role agents (pba-planner / pba-builder / pba-auditor) are markdown
// agents in `.opencode/agents/` — the plugin spawns them as child sessions and
// drives the loop deterministically from persisted state under `.pba/`.
//
// Configuration via opencode.json(c):
//   {
//     "plugins": [
//       {
//         "package": ".opencode/plugins/pba",
//         "options": {
//           "stateDir": ".pba",        // coordination dir, relative to the repo
//           "maxAttempts": 3,          // build attempts before escalation
//           "models": {                // optional per-role model overrides
//             "plan": "provider/model",
//             "build": "provider/model",
//             "audit": "provider/model"
//           }
//         }
//       }
//     ]
//   }

import { Plugin, type Skill } from "@opencode/plugin"
import { promises as fs } from "node:fs"
import path from "node:path"
import { registerCommands } from "./commands"
import { SKILL_CONTENT } from "./prompts"
import { resolveConfig } from "./orchestrator"
import { registerTools, type SessionLoopMap } from "./tools"

export interface PbaPluginOptions {
  stateDir?: string
  maxAttempts?: number
  models?: { plan?: string; build?: string; audit?: string }
}

export default Plugin.define({
  id: "pba",
  async setup(ctx) {
    const config = resolveConfig(ctx.location.directory, (ctx.options ?? {}) as PbaPluginOptions)
    const sessionLoops: SessionLoopMap = new Map()

    await registerTools(ctx, config, sessionLoops)
    await registerCommands(ctx, config, sessionLoops)
    await registerSkill(ctx, config)
  },
})

/** Register the "pba-loop" skill so primary agents can trigger the loop naturally. */
async function registerSkill(
  ctx: Parameters<Parameters<typeof Plugin.define>["0"]["setup"]>[0],
  config: ReturnType<typeof resolveConfig>,
): Promise<void> {
  // The skill needs an absolute path; materialize SKILL.md in the state root
  // so it exists regardless of how the plugin itself is packaged.
  const skillPath = path.join(config.rootDir, config.stateDirName, "SKILL.md")
  try {
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    const existing = await fs.readFile(skillPath, "utf8").catch(() => undefined)
    if (existing !== SKILL_CONTENT) {
      await fs.writeFile(skillPath, SKILL_CONTENT, "utf8")
    }
  } catch (cause) {
    console.error(`[pba] could not write skill file to ${skillPath}: ${(cause as Error).message}`)
  }

  await ctx.skill.transform((editor) => {
    editor.add({
      id: "pba-loop" as Skill.ID,
      name: "PBA loop" as Skill.Name,
      description:
        "Run a supervised plan-build-audit loop: planner writes a plan, builder implements it, auditor approves or sends it back. Use when the user asks for the PBA loop or wants a planned, built, and independently audited change.",
      path: skillPath as unknown as Skill.Info["path"],
      content: SKILL_CONTENT,
    })
  })
}
