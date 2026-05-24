# TabNap

**Suspend inactive tabs to free memory — let your tabs take a nap.**

A lightweight Chrome extension (Manifest V3) that automatically suspends tabs you're not using, freeing up RAM without losing your browsing session.

## Features

- **Auto-suspend** — configurable inactivity timer (5 min → 8 hours, or never)
- **Smart exclusions** — skip pinned tabs, tabs playing audio, tabs with unsaved form input, or tabs using camera/mic
- **Exception list** — whitelist specific URLs or entire domains that should never suspend
- **Manual suspend** — keyboard shortcut (`Alt+S`) or right-click context menu
- **Sleeping tabs panel** — see all suspended tabs at a glance, wake any of them with one click
- **Recoverable tabs** — closed tabs whose pages were saved can be reopened
- **Tab groups aware** — restored tabs return to their original group
- **Localized** — English and French (`_locales/en`, `_locales/fr`)

## Installation

### From the Chrome Web Store

*(link coming soon)*

### Load unpacked (development)

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select this directory

To reload after changes: click the refresh icon on `chrome://extensions`.

## Project structure

```
manifest.json       — permissions, service worker, content scripts
background.js       — service worker: suspension logic, alarms, tab tracking
content.js          — detects user activity to reset idle timers
mediadetect.js      — detects audio/video/camera usage (runs in page context)
suspended.html/js   — page shown for suspended tabs; click to restore
popup/              — toolbar popup UI (settings, sleeping tabs list)
_locales/           — i18n strings (en, fr)
icons/              — extension icons (16, 32, 48, 128 px)
docs/               — privacy policy
```

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read and update tab URLs and titles |
| `storage` | Persist settings (timer, whitelist) |
| `alarms` | Fire suspension timers reliably in the service worker |
| `scripting` | Inject content scripts to detect activity |
| `tabGroups` | Restore tabs into their original group |
| `contextMenus` | Right-click "Suspend other tabs / Never suspend this site" |
| `history` | Keep suspended pages out of browser history |

## MV3 notes

- Background runs as a **service worker** — no persistent globals. State is persisted to `chrome.storage.session` / `chrome.storage.local`.
- `chrome.alarms` minimum interval is 1 minute in production (no limit in dev mode).

## License

MIT
