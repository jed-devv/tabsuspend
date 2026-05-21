# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome extension that suspends inactive tabs to free memory, similar to The Great Suspender or TabSuspender.

## Architecture

Manifest V3 extension (required for Chrome Web Store since 2023).

Key components:
- `manifest.json` — declares permissions (`tabs`, `storage`, `alarms`), background service worker, and popup
- `background.js` — service worker: tracks tab activity via `chrome.tabs` events, schedules suspension with `chrome.alarms`, replaces tab URL with `suspended.html?url=...&title=...`
- `popup/` — extension toolbar UI for settings (timeout threshold, whitelist)
- `suspended.html` — the page shown for suspended tabs; clicking it restores the original URL
- `content.js` (optional) — detects user activity in a tab to reset its idle timer

## Build & Load

No build step needed (pure JS/HTML/CSS).

To load the extension locally:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this directory

To reload after changes: click the refresh icon on `chrome://extensions` or use the [Extensions Reloader](https://chrome.google.com/webstore/detail/extensions-reloader) extension.

## Permissions used

- `tabs` — read/update tab URLs and titles
- `storage` — persist user settings (timeout, whitelist)
- `alarms` — fire suspension timers (more reliable than `setTimeout` in service workers)

## MV3 constraints

- Background runs as a **service worker** (no persistent background page); avoid globals that don't survive restarts — persist state to `chrome.storage.session` or `chrome.storage.local`.
- `chrome.alarms` minimum interval is 1 minute in production (no limit in dev).
