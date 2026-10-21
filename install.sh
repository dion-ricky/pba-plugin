#!/usr/bin/env bash
# install.sh — install the PBA plugin into a target project (project-local only).
#
# Usage:
#   bash install.sh [target-dir] [--copy] [--control subagent|herdr] [--yes]
#
#   target-dir      project to install into (default: current directory)
#   --copy          copy the plugin folder into <target>/.opencode/plugins/pba
#                   instead of referencing it by absolute path
#   --control MODE  skip the prompt and set the loop control mode:
#                   "subagent" (default; roles run as plugin child sessions) or
#                   "herdr" (roles run as full OpenCode TUIs in herdr panes)
#   --yes, -y       do not prompt; keep the existing control mode (or default
#                   to "subagent" on a fresh config)
#
# What it does:
#   1. Reads the pba-* agent definitions from ./agents/*.md (single source of
#      truth) and converts them to `agents` config entries.
#   2. Asks which control mode to use (unless --control, --yes, or a
#      non-interactive stdin), then adds the plugin with the matching `options`
#      to the target's `plugins` config.
#   3. Writes/merges opencode.json(c) in the target — existing config is backed
#      up before any modification; if it cannot be parsed, the exact snippet to
#      merge manually is printed instead.
#
# Nothing is installed globally. Requires `node` on PATH.

set -euo pipefail

usage() {
  # Print this script's leading comment block (after the shebang) verbatim.
  awk 'NR > 2 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

COPY_MODE=0
YES=0
CONTROL_MODE=""
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy) COPY_MODE=1; shift ;;
    --control)
      CONTROL_MODE="${2:-}"
      if [[ -z "$CONTROL_MODE" ]]; then
        echo "error: --control needs a value (subagent|herdr)" >&2
        exit 1
      fi
      shift 2
      ;;
    --control=*) CONTROL_MODE="${1#--control=}"; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    *) TARGET="$1"; shift ;;
  esac
done
TARGET="${TARGET:-$PWD}"

if [[ -n "$CONTROL_MODE" && "$CONTROL_MODE" != "subagent" && "$CONTROL_MODE" != "herdr" ]]; then
  echo "error: --control must be 'subagent' or 'herdr' (got '${CONTROL_MODE}')" >&2
  exit 1
fi
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="${PLUGIN_DIR}/agents"

if [[ ! -d "$TARGET" ]]; then
  echo "error: target directory does not exist: $TARGET" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is required on PATH to run this installer." >&2
  exit 1
fi
if [[ ! -f "${AGENTS_DIR}/pba-builder.md" ]]; then
  echo "error: agent definitions not found at ${AGENTS_DIR} — the agents/ folder must sit next to install.sh." >&2
  exit 1
fi

TARGET_ABS="$(cd "$TARGET" && pwd)"

# Ask which control mode the loop should use. Skipped when --control was given,
# when --yes was passed, or when stdin is not interactive (piped/CI); in those
# cases the Node step keeps the target's existing mode (default: subagent).
if [[ -z "$CONTROL_MODE" && $YES -eq 0 && -t 0 && -t 1 ]]; then
  echo
  echo "PBA loop control mode:"
  echo "  1) subagent  roles run as invisible plugin child sessions (default)"
  echo "  2) herdr     builder/auditors run as full OpenCode TUIs in herdr panes"
  while :; do
    printf 'Choose [1/2] (Enter keeps the current setting): '
    read -r answer || answer=""
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    case "$answer" in
      "") CONTROL_MODE="keep"; break ;;
      1|s|subagent) CONTROL_MODE="subagent"; break ;;
      2|h|herdr) CONTROL_MODE="herdr"; break ;;
      *) echo "Please enter 1 or 2." ;;
    esac
  done
  echo
fi

TARGET="$TARGET_ABS" PLUGIN_DIR="$PLUGIN_DIR" AGENTS_DIR="$AGENTS_DIR" COPY_MODE=$COPY_MODE CONTROL_MODE="$CONTROL_MODE" node <<'NODE_EOF'
const fs = require("node:fs")
const path = require("node:path")

const TARGET = process.env.TARGET
const PLUGIN_DIR = process.env.PLUGIN_DIR
const AGENTS_DIR = process.env.AGENTS_DIR
const COPY_MODE = process.env.COPY_MODE === "1"

const ROLE_IDS = ["pba-builder", "pba-auditor"]

// --- control mode ------------------------------------------------------------

// "keep" (or unset) preserves the target's existing mode and falls back to the
// plugin default. The bash prompt passes "keep" when the user just hits Enter.
const RAW_CONTROL = process.env.CONTROL_MODE || "keep"
if (!["keep", "subagent", "herdr"].includes(RAW_CONTROL)) {
  console.error(`error: invalid control mode "${RAW_CONTROL}" (expected subagent or herdr)`)
  process.exit(1)
}

/** Build the plugin `options` block for a control mode, preserving other keys. */
function optionsFor(mode, prev) {
  const options = { ...(prev && typeof prev === "object" ? prev : {}), control: mode }
  if (mode === "herdr") {
    options.herdr =
      options.herdr && typeof options.herdr === "object"
        ? options.herdr
        : { ratio: 0.5, promptTimeoutMs: 600000 }
  } else {
    delete options.herdr
  }
  return options
}

/** The plugin entry matching a package ref, or undefined. */
function findPluginEntry(list, packageRef) {
  return list.find((p) => (typeof p === "string" ? p : p && p.package) === packageRef)
}

/** The control mode already configured for a package ref, if any. */
function existingControl(config, packageRef) {
  if (!Array.isArray(config.plugins)) return undefined
  const entry = findPluginEntry(config.plugins, packageRef)
  const mode = entry && typeof entry === "object" ? entry.options && entry.options.control : undefined
  return mode === "herdr" || mode === "subagent" ? mode : undefined
}

// --- JSONC handling ---------------------------------------------------------

// Comment/trailing-comma stripper that is string-aware. Note: the trailing
// comma pass operates on the comment-stripped text and assumes ", }" and ", ]"
// sequences do not appear verbatim inside string values (rare; existing config
// is backed up before any write).
function stripJsonc(src) {
  let out = ""
  let inStr = false
  let quote = ""
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = i + 1 < src.length ? src[i + 1] : ""
    if (inStr) {
      out += c
      if (c === "\\") {
        out += next
        i++
      } else if (c === quote) {
        inStr = false
      }
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i + 1 < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function parseConfig(text) {
  const parsed = JSON.parse(stripJsonc(text))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("top-level config is not an object")
  }
  return parsed
}

// --- agent markdown -> config entry -----------------------------------------

function unquote(value) {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

function parseAgentMd(file) {
  const raw = fs.readFileSync(file, "utf8")
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error(`no frontmatter in ${file}`)
  const [, fm, body] = match

  const agent = {}
  let listKey = null
  let currentItem = null
  for (const line of fm.split("\n")) {
    if (/^\s*-\s/.test(line) && listKey) {
      currentItem = {}
      const rest = line.replace(/^\s*-\s+/, "")
      const idx = rest.indexOf(":")
      currentItem[rest.slice(0, idx).trim()] = unquote(rest.slice(idx + 1))
      agent[listKey].push(currentItem)
    } else if (/^\s+[a-z]+:\s/.test(line) && currentItem) {
      const idx = line.indexOf(":")
      currentItem[line.slice(0, idx).trim()] = unquote(line.slice(idx + 1))
    } else if (/^[a-z]+:\s*$/.test(line)) {
      listKey = line.slice(0, -1).trim()
      agent[listKey] = []
      currentItem = null
    } else if (/^[a-z]+:\s/.test(line)) {
      const idx = line.indexOf(":")
      agent[line.slice(0, idx).trim()] = unquote(line.slice(idx + 1))
      listKey = null
      currentItem = null
    }
  }

  const entry = { description: agent.description, mode: agent.mode || "all" }
  if (agent.color) entry.color = agent.color
  if (Array.isArray(agent.permissions) && agent.permissions.length > 0) {
    entry.permissions = agent.permissions
  }
  entry.system = body.trim()
  return entry
}

const agents = {}
for (const id of ROLE_IDS) {
  agents[id] = parseAgentMd(path.join(AGENTS_DIR, `${id}.md`))
}

// --- locate or create the target config --------------------------------------

const candidates = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]
let configFile = null
let config = {}
for (const rel of candidates) {
  const abs = path.join(TARGET, rel)
  if (fs.existsSync(abs)) {
    configFile = abs
    try {
      config = parseConfig(fs.readFileSync(abs, "utf8"))
    } catch (cause) {
      console.error(`error: ${rel} could not be parsed as JSONC (${cause.message}).`)
      console.error("Merge this manually:\n")
      const snippetControl = RAW_CONTROL === "keep" ? "subagent" : RAW_CONTROL
      console.error(
        JSON.stringify(
          {
            plugins: [
              {
                package: COPY_MODE ? path.join(TARGET, ".opencode/plugins/pba") : PLUGIN_DIR,
                options: optionsFor(snippetControl, undefined),
              },
            ],
            agents,
          },
          null,
          2,
        ),
      )
      process.exit(1)
    }
    break
  }
}
if (!configFile) {
  configFile = path.join(TARGET, "opencode.jsonc")
  config = { $schema: "https://opencode.ai/config.json" }
}

// --- copy mode: vendor the plugin folder -------------------------------------

let packageRef = PLUGIN_DIR
if (COPY_MODE) {
  const dest = path.join(TARGET, ".opencode", "plugins", "pba")
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(PLUGIN_DIR, dest, { recursive: true, filter: (src) => !path.basename(src).startsWith(".") })
  packageRef = dest
}

// --- merge -------------------------------------------------------------------

const control = RAW_CONTROL === "keep" ? existingControl(config, packageRef) ?? "subagent" : RAW_CONTROL

if (!Array.isArray(config.plugins)) config.plugins = []
const existing = findPluginEntry(config.plugins, packageRef)
if (existing === undefined) {
  config.plugins.push({ package: packageRef, options: optionsFor(control, undefined) })
} else if (typeof existing === "string") {
  config.plugins[config.plugins.indexOf(existing)] = { package: packageRef, options: optionsFor(control, undefined) }
} else {
  existing.package = packageRef
  existing.options = optionsFor(control, existing.options)
}

config.agents = config.agents && typeof config.agents === "object" ? config.agents : {}
for (const [id, def] of Object.entries(agents)) {
  if (config.agents[id]) console.log(`note: overwriting existing agent "${id}"`)
  config.agents[id] = def
}

// --- write (with backup) -----------------------------------------------------

if (fs.existsSync(configFile)) {
  const backup = `${configFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`
  fs.copyFileSync(configFile, backup)
  console.log(`backed up existing config to ${backup}`)
}
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf8")

console.log(`\ninstalled PBA plugin into ${configFile}`)
console.log(`  plugin: ${packageRef}${COPY_MODE ? " (copied)" : " (referenced by path)"}`)
console.log(`  agents: ${ROLE_IDS.join(", ")}`)
console.log(
  `  control: ${control}${control === "herdr" ? " (roles run as TUIs in herdr panes)" : " (roles run as plugin child sessions)"}`,
)
if (control === "herdr") {
  console.log(`    herdr mode requires the herdr CLI on PATH and OpenCode running inside a herdr pane.`)
}
console.log(`\nNext steps:`)
console.log(`  1. Open an OpenCode session in ${TARGET}`)
console.log(`  2. Run:  /pba <spec>   (or just ask for "the PBA loop")`)
console.log(`  3. Add ".pba/" to the project's .gitignore — loop state is not source`)
NODE_EOF
