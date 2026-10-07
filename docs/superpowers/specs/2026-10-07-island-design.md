# Island — a Dynamic Island for Windows

## Goal
A black pill pinned to the top-centre of the screen that surfaces, at a glance:
Google Calendar events, the currently playing media (with controls), and Claude Code
state (sessions waiting on you / finished, your open PRs with CI, branches pushed without a PR).

## Shape
- Electron, one transparent frameless always-on-top window (480×320), click-through except over the pill.
- Collapsed pill (240×38, wider when alerting) shows the single most important item:
  1. a Claude session waiting on you (orange pulse)
  2. a Claude session that just finished (green, 10s)
  3. a calendar event starting within 10 minutes / just started
  4. the playing track
  5. the clock
- Hover expands to 440×280 with tabs: Now Playing · Calendar · Claude.
- Tray icon: Refresh, Open config, Start with Windows, Quit.

## Sources (one module each, `src/`)
| Module | Mechanism | Refresh |
|---|---|---|
| `calendar.js` | fetch secret iCal URL(s), expand recurrences with `ical-expander`, today + tomorrow | 5 min |
| `media.js` + `media.ps1` | long-lived PowerShell helper using Windows `GlobalSystemMediaTransportControls`; JSON lines out, `toggle/next/prev` in | 1 s, change-only |
| `claude.js` | HTTP server on `127.0.0.1:47777`, `POST /hook` (JSON only) fed by Claude Code hooks via `hooks/island-hook.js` | push |
| `github.js` | `gh api graphql` (your PRs + CI rollup) and `gh api users/<you>/events` (pushes in last 24h) | 60 s |

Claude session states, keyed by `session_id`:
`PermissionRequest`/`Notification` → waiting · `UserPromptSubmit`/`PostToolUse`/`SessionStart` → working ·
`Stop`/`StopFailure` → done · `SessionEnd` → removed. Waiting expires after 30 min, anything after 60 min idle.

## Config
`config.json` (gitignored, created from `config.example.json`): `icalUrls`, `display`, `offsetY`, `claudePort`,
refresh intervals. Edited file is picked up live.

## Errors
Each source reports `{status: ok|error|unconfigured}`; the tab shows a one-line message, the island keeps running.
The hook script never blocks Claude: 500 ms timeout, always exits 0, prints nothing.

## Tests
`node --test`: iCal expansion (recurrence, override, all-day, join link), Claude state reducer, GitHub mapping.
