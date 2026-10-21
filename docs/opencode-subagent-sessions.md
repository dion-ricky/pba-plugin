# Attaching to Subagent Sessions from the OpenCode CLI

## Summary

Subagent (child) sessions are ordinary sessions on the OpenCode background
service. There is no dedicated `--subagent` flag, but `--session` / `-s`
attaches to any session by ID, including subagent child sessions.

## Usage

```bash
opencode --session <child-session-id>        # full TUI
opencode mini --session <child-session-id>   # minimal UI
```

- `--continue` / `-c` only resumes the most recent session and takes no ID.
- `--session` / `-s <id>` continues an existing session, or creates one if
  the ID does not exist.

## Finding a subagent session ID

`opencode session list` intentionally shows **top-level sessions only**.
Child sessions are linked to their parent via `parentID` and are exposed
through the server API:

```bash
opencode api get /api/session | python3 -c "
import json, sys
for s in json.load(sys.stdin):
    if s.get('parentID') == 'ses_XXXXparent':
        print(s['id'], s.get('title', ''))
"
```

Then attach to the ID you want:

```bash
opencode -s ses_XXXXchild
```

## Notes

- Attaching works even while the subagent is still running, because all
  clients connect to the same shared background service.
- Verified with `opencode --session <child-id>` on 2026-10-20.
- The docs (https://opencode.ai/v2/docs/cli) do not mention attaching to
  child sessions; this behavior is undocumented but works.

## Related: herdr-driven role sessions

When the PBA plugin runs with `control: "herdr"`, role sessions are not child
sessions but full OpenCode TUIs launched in herdr panes (see
`docs/herdr-agent-automation-plan.md` and the `herdr.ts` adapter). The native
session IDs of those TUIs are recorded in the loop's `state.json`
(`sessions` / `herdrPanes`), so the same `opencode -s <id>` attach flow works
for them too. The default `control: "subagent"` mode is what this document
describes.
