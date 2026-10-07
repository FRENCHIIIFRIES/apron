# Apron

A Nothing-style Dynamic Island for Windows. A black notch at the top of the screen that shows what matters right now and opens on hover.

- **Music.** Whatever is playing in Spotify, a browser, or any app that uses Windows media controls. Play/pause, skip, volume (scroll the music tab), synced **lyrics**, album art in black & white or colour, and a short peek when the track changes.
- **Google Calendar + weather.** Today and tomorrow from your calendar's secret iCal link, a live "12m left" countdown for the current class, Join buttons for Meet/Zoom/Teams, the temperature, and a warning when rain is likely before your next class.
- **Claude Code.** The notch pulses when a session needs you, and you can **Allow or Deny permission requests right from the notch** (the terminal prompt still works too, whichever you answer first wins). Also your open PRs with CI status and branches pushed without a PR.
- **Focus + lockdown.** 5/15/25/50 minute timers. With lockdown on, Instagram, TikTok, X, Reddit and other distracting sites get their tab closed the moment you open them; YouTube and Spotify stay allowed. Distracting apps' notifications stay quiet too.
- **Notifications.** Windows notifications (Discord, WhatsApp, anything) peek in the notch. If your phone is linked with Phone Link, **2FA codes** texted to your phone pop up big with a Copy button, and **incoming calls** ring in the notch.
- **Pomodoro + streaks.** Focus/break cycles that run on their own (long break every few rounds), a daily streak, and **screen time** per site/app as a dot graph (labels only, never page titles).
- **School.** Homework due dates from ManageBac / Google Classroom calendar links, and countdowns ("31 days to exam" events are picked up automatically).
- **Quick launcher.** Ctrl+Alt+Space, then type: apps from the Start menu, Desktop files, websites. `? question` asks the AI (needs a free Gemini key or an Anthropic key, stored encrypted), `n …` saves a note to your Obsidian vault, `t …` adds a to-do.
- **Share the song** (a song.link page that opens in Spotify and everywhere else), **mic/camera dots** next to the notch like a phone, and an optional **sleep reminder**.
- **Home screen.** Hover the notch and you get a grid of widgets (music, next class, weather, homework due, focus, to-dos, Claude Code, system) with an icon dock along the top. Pick and order the widgets in Settings.
- **AI (Gemini by default, or Claude).** `?` questions, `??` questions about what's on your screen, translation (`tr …`, or automatically for copied Hindi), and a **homework planner** that fits focus blocks into your free time.
- **Class mode** (quiet notifications + lockdown during school hours), **flashcards** from `question :: answer` lines in your Obsidian notes during Pomodoro breaks, a **daily summary**, a **System** view (CPU, RAM, battery time left, Wi-Fi), **Spotify** like/playlists (connect your own Spotify app), and offline **"Hey Apron" voice commands**.
- **To-do list, clipboard history** (memory only; things that look like passwords are masked), battery notices, accent colours, one notch on every screen, and a full **Settings window** (click the tray icon).

## Install

Download `Apron-Setup-x.y.z.exe` from [Releases](https://github.com/FRENCHIIIFRIES/apron/releases) and run it. Apron starts with Windows and updates itself: new versions download in the background and install on the next restart, or straight away from the tray menu or the blinking **Update** button.

Windows may warn that the installer is from an unknown publisher (it isn't code-signed). Click **More info → Run anyway**.

## Set up

Right-click the tray icon → **Open config** (`%APPDATA%\Apron\config.json`):

```json
{
  "icalUrls": ["https://calendar.google.com/calendar/ical/.../private-.../basic.ics"],
  "accent": "#d71921",
  "artColor": false,
  "startWithWindows": true,
  "weatherCity": "Hyderabad, IN",
  "displays": "all",
  "notifications": true,
  "clipboard": true,
  "lockdown": {
    "extraSites": ["chess.com"],
    "allowSites": [],
    "unblock": ["Discord"],
    "apps": ["RobloxPlayerBeta.exe"]
  },
  "offsetY": 0
}
```

`lockdown`: `extraSites` adds sites to block, `allowSites` always allows them, `unblock` removes built-in ones (by name), and `apps` minimises those programs during focus.

Get the iCal link from Google Calendar → Settings → your calendar → **Secret address in iCal format**. Keep it private: anyone with it can read your calendar.

**Claude Code status** needs hooks in `~/.claude/settings.json`. From a clone of this repo:

```bash
npm run hooks:install
```

Existing hooks are kept and a backup is written next to the file. `npm run hooks:uninstall` removes them.

**GitHub PRs** come from the [GitHub CLI](https://cli.github.com/): install it and run `gh auth login`.

## Develop

```bash
npm install
npm start        # run from source
npm test
npm run dist     # build the installer into dist/
```

`APRON_EXPAND=media` (or `calendar`, `claude`, `timer`, `todo`, `clip`) pins the island open on a tab, for screenshots.

## Release

```bash
npm run release
```

This bumps the patch version, tags it and pushes. GitHub Actions builds the installer and publishes the release, and installed copies update themselves.
