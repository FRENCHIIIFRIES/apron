# Apron

A Nothing-style Dynamic Island for Windows. A black notch at the top of the screen that shows what matters right now and opens on hover.

- **Music.** Whatever is playing in Spotify, a browser, or any app that uses Windows media controls. Play/pause, skip, volume (scroll the music tab), album art in black & white or colour, and a short peek when the track changes.
- **Google Calendar.** Today and tomorrow from your calendar's secret iCal link, a live "12m left" countdown for the current class, Join buttons for Meet, Zoom and Teams links.
- **Claude Code.** The notch pulses when a session needs you and flashes when one finishes. You also see your open PRs with CI status, and branches you pushed without a PR.
- **Focus timer**, battery notices, an accent colour picker, and **Ctrl+Alt+Space** to keep it open.

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
  "offsetY": 0
}
```

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

`APRON_EXPAND=media` (or `calendar`, `claude`, `timer`) pins the island open on a tab, for screenshots.

## Release

```bash
npm run release
```

This bumps the patch version, tags it and pushes. GitHub Actions builds the installer and publishes the release, and installed copies update themselves.
