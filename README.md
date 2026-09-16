# Smart Tab Sorter

A Chrome extension that keeps your tabs organized automatically — live, on close, and across browser restarts.

## What it does

- **Live sorting**: as tabs load, it puts them into color-coded Chrome tab groups based on domain (dev, social, video, shopping, news, docs, AI tools, etc.) and, as a fallback, on keywords in the page title. Pull a tab out of a group on purpose and it's left alone until you navigate it somewhere new.
- **Closed-tab archive**: every tab you close is captured (URL, title, category, timestamp) into a searchable-by-scroll archive, deduplicated by URL, capped at 500 entries by default — click any entry to reopen it.
- **Session snapshots**: save your current tabs (across all windows) as a named session, or let it auto-snapshot every N minutes and whenever a window closes, so nothing is ever lost mid-crash.
- **One-click restore**: reopen any saved session — it recreates the windows, tabs, and category groups. Optionally auto-restore your last session on browser startup.
- **Custom rules**: add your own domain → category mappings in the Options page; they're checked before the built-ins.

## Install (unpacked, for local/dev use)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `smart-tab-sorter` folder.
4. Pin the extension from the puzzle-piece menu for quick access.

## Using it

- Click the toolbar icon to see **Live** (current window's tabs grouped), **Sessions** (save/restore), **Closed** (recently closed archive), and **Settings** (toggle auto-sort, auto-restore, save interval).
- Right-click the toolbar icon → **Options** to add custom domain rules.

## Notes

- Auto-restore on startup is off by default to avoid duplicating Chrome's own "continue where you left off" if you have that enabled — turn on only one of the two.
- Categorization is fully local (domain + keyword rules); no data leaves your browser and no API keys are needed.
- Permissions used: `tabs`, `tabGroups`, `storage`, `alarms` — no host permissions, no page content is read.
