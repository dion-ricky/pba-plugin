#!/usr/bin/env bash
# Real-herdr smoke test for the PBA plugin's herdr control path.
#
# Exercises the exact CLI/API sequence the orchestrator uses, against your
# installed herdr + opencode (no fakes), and prints PASS/FAIL per step. It
# spawns one throwaway opencode TUI pane and closes it at the end (also on
# failure).
#
# The flow mirrors spawnHerdrPhaseSession: pre-create a session via the
# opencode API, split a pane, start the full TUI resuming that session
# (`-s <id> --auto`), prompt it, and confirm herdr reports the SAME session.
#
# Usage: run from INSIDE a herdr pane (HERDR_PANE_ID must be set):
#   bash scripts/herdr-real-smoke.sh
#
# Requires: herdr on PATH, opencode on PATH, jq.

set -u

fail() { echo "FAIL: $*"; exit 1; }

command -v herdr >/dev/null || fail "herdr not on PATH"
command -v opencode >/dev/null || fail "opencode not on PATH"
command -v jq >/dev/null || fail "jq not on PATH"
[ -n "${HERDR_PANE_ID:-}" ] || fail "HERDR_PANE_ID is not set — run this from inside a herdr pane"

PANE_ID=""
TAB_ID=""
cleanup() {
  if [ -n "$TAB_ID" ]; then
    herdr tab close "$TAB_ID" >/dev/null 2>&1 || echo "note: could not close test tab $TAB_ID"
  fi
  if [ -n "$PANE_ID" ]; then
    herdr pane close "$PANE_ID" >/dev/null 2>&1 || echo "note: could not close test pane $PANE_ID"
  fi
}
trap cleanup EXIT

echo "herdr version: $(herdr --version)"
echo "opencode version: $(opencode --version)"

# 1. Resolve the anchor pane. `pane current` trusts HERDR_PANE_ID, which can
#    go stale after layout changes; fall back to finding the opencode agent
#    running in the current working directory.
ANCHOR=$(herdr pane current 2>/dev/null | jq -r '.result.pane.pane_id // empty')
if [ -z "$ANCHOR" ] || [ "$ANCHOR" = "null" ]; then
  ANCHOR=$(herdr agent list 2>/dev/null | jq -r --arg cwd "$PWD" \
    '.result.agents[] | select(.agent == "opencode" and .cwd == $cwd) | .pane_id' | head -1)
fi
[ -n "$ANCHOR" ] && [ "$ANCHOR" != "null" ] || fail "could not resolve the current herdr pane"
PANE_ID=$(herdr pane split "$ANCHOR" --direction right --ratio 0.5 --no-focus | jq -r '.result.pane.pane_id')
[ -n "$PANE_ID" ] && [ "$PANE_ID" != "null" ] || fail "pane split returned no pane_id"
echo "PASS: pane split -> $PANE_ID"

# 2. Agent name rule: 1-32 chars, [a-z0-9-_], starts with a letter. The
#    orchestrator's scheme is pba-<role>-a<attempt>(r<retry>)-<8-hex>.
AGENT_NAME="pba-smoke-a1-$(printf %08x "$(date +%s)")"
echo "PASS: agent name $AGENT_NAME (${#AGENT_NAME} chars, <= 32)"

# 3. Pre-create the role session via the opencode API (the plugin uses
#    ctx.session.create with agent+model; the server default is fine here).
CREATE_OUT=$(opencode api post /api/session -d "{\"title\":\"pba-smoke $(date +%s)\"}" 2>&1)
SESSION_ID=$(echo "$CREATE_OUT" | jq -r '.data.id // .id' 2>/dev/null)
[ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ] || fail "opencode api session create failed: $CREATE_OUT"
echo "PASS: session pre-created via API -> $SESSION_ID"

# 4. Start the full TUI resuming that session. No --agent/--model flags exist
#    on the TUI; the session carries agent/model/variant.
START_OUT=$(herdr agent start "$AGENT_NAME" --kind opencode --pane "$PANE_ID" -- -s "$SESSION_ID" --auto 2>&1)
echo "$START_OUT" | jq -e '.result.agent.name' >/dev/null 2>&1 || fail "agent start failed: $START_OUT"
echo "PASS: agent start (full TUI resuming $SESSION_ID in $PANE_ID)"

# 5. Prompt the TUI and wait for the turn to settle.
PROMPT_OUT=$(herdr agent prompt "$AGENT_NAME" "Reply with exactly: ok" --wait --timeout 120000 2>&1)
echo "$PROMPT_OUT" | jq -e '.result.agent.agent_status' >/dev/null 2>&1 ||
  fail "agent prompt failed: $PROMPT_OUT"
echo "PASS: prompt delivered and turn settled"

# 6. herdr must report the SAME session the orchestrator created — that
#    identity match is what makes role enforcement work.
GET_OUT=$(herdr agent get "$AGENT_NAME")
REPORTED=$(echo "$GET_OUT" | jq -r '.result.agent.agent_session.value // empty')
[ "$REPORTED" = "$SESSION_ID" ] ||
  fail "herdr reported session $REPORTED, expected the pre-created $SESSION_ID"
echo "PASS: herdr reports the pre-created session (identity match)"

# 7. The turn actually ran on the pre-created session (cost/tokens recorded).
SESSION_OUT=$(opencode api get "/api/session/$SESSION_ID" 2>&1)
echo "$SESSION_OUT" | jq -e '.data.id // .id' >/dev/null 2>&1 || fail "session fetch failed: $SESSION_OUT"
echo "PASS: session alive after the turn: $(echo "$SESSION_OUT" | jq -r '.data.agent // .agent // "agent=?") ' 2>/dev/null | tr -d '\n')"

# 8. agent read works (used for timeout/stall diagnostics).
READ_OUT=$(herdr agent read "$AGENT_NAME" 2>&1)
[ -n "$READ_OUT" ] || fail "agent read returned empty output"
echo "PASS: agent read returned ${#READ_OUT} chars"

# 9. Balanced audit column: build a 4-pane column with planBalancedColumn's
#    ratios (all 0.5) in a throwaway tab and confirm the leaf heights differ by
#    at most herdr's unavoidable 1-row rounding. The plan for n=4 is
#    right @0.5, down @0.5 (source slot 0), down @0.5 (source slot 0),
#    down @0.5 (source slot 1); leaves are slots [0, 2, 1, 3].
TAB_OUT=$(herdr tab create --cwd "$PWD" --label pba-balanced-smoke --no-focus 2>&1)
TAB_ID=$(echo "$TAB_OUT" | jq -r '.result.tab.tab_id // empty')
ROOT_PANE=$(echo "$TAB_OUT" | jq -r '.result.root_pane.pane_id // empty')
[ -n "$TAB_ID" ] && [ "$TAB_ID" != "null" ] || fail "tab create returned no tab_id: $TAB_OUT"
[ -n "$ROOT_PANE" ] && [ "$ROOT_PANE" != "null" ] || fail "tab create returned no root_pane: $TAB_OUT"
echo "PASS: throwaway tab -> $TAB_ID (root pane $ROOT_PANE)"

split_down() {
  herdr pane split "$1" --direction down --ratio 0.5 --no-focus | jq -r '.result.pane.pane_id'
}
COL0=$(herdr pane split "$ROOT_PANE" --direction right --ratio 0.5 --no-focus | jq -r '.result.pane.pane_id')
COL1=$(split_down "$COL0")
COL2=$(split_down "$COL0")
COL3=$(split_down "$COL1")
for p in "$COL0" "$COL1" "$COL2" "$COL3"; do
  [ -n "$p" ] && [ "$p" != "null" ] || fail "balanced column split returned no pane_id"
done
LEAVES="$COL0 $COL2 $COL1 $COL3"

LAYOUT=$(herdr pane layout --pane "$COL0" 2>&1)
HEIGHTS=""
for p in $LEAVES; do
  h=$(echo "$LAYOUT" | jq -r --arg p "$p" '.result.layout.panes[] | select(.pane_id == $p) | .rect.height // empty')
  [ -n "$h" ] && [ "$h" != "null" ] || fail "pane layout has no rect height for $p: $LAYOUT"
  HEIGHTS="$HEIGHTS $h"
done
SPREAD=$(echo $HEIGHTS | awk '{min=$1; max=$1; for(i=2;i<=NF;i++){if($i<min)min=$i; if($i>max)max=$i} print max-min}')
[ "$SPREAD" -le 1 ] || fail "balanced column leaf heights uneven: [$HEIGHTS] spread=$SPREAD"
echo "PASS: balanced 4-pane column heights [$HEIGHTS] (spread $SPREAD <= 1)"

echo
echo "ALL REAL-HERDR SMOKE CHECKS PASSED"
echo "(the test pane $PANE_ID and tab $TAB_ID are closed by the EXIT trap)"
