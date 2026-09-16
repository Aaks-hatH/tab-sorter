# Smart Tab Sorter

A Chrome extension that keeps your tabs organized automatically — live, on close, and across browser restarts.

## What it does

- **Zero-effort smart sorting**: new, navigated, and moved tabs are tidied automatically. It recognizes common workspaces (dev, AI, work, finance, research, media, and more), learns your custom domain rules first, then creates useful same-site and shared-topic groups for everything else.
- **Respectful automation**: pinned tabs can be protected, and pulling a tab out of a group is treated as a preference until that tab navigates somewhere new.
- **One-click Tidy**: the popup's ✦ Tidy control groups the current window and closes inactive, unpinned duplicate URLs. Duplicate auto-closing is opt-in in Settings.
- **At-a-glance health**: the Live view shows open tabs, recognized tabs, and duplicate count before you decide to act.
- **Focus and retrieval**: use Focus to tuck social, video, and shopping distractions into a collapsed “Later” group, and use the popup search to jump to any open tab, closed page, or saved session.
- **Stale-tab awareness**: tracks local tab activity and surfaces tabs that have not been revisited within your selected freshness window.
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

- Click the toolbar icon to see **Live** (current window's groups and health), **Sessions** (save/restore), **Closed** (recently closed archive), and **Settings**.
- Keep the defaults for a hands-off experience, or tune same-site grouping, topic discovery, pinned-tab protection, duplicate removal, Focus behavior, stale-tab timing, smart-group size, auto-restore, and snapshot interval in **Settings**.
- Right-click the toolbar icon → **Options** to add custom domain rules.

## Notes

- Auto-restore on startup is off by default to avoid duplicating Chrome's own "continue where you left off" if you have that enabled — turn on only one of the two.
- Categorization is fully local (domain + title-topic heuristics); no data leaves your browser and no API keys are needed.
- Permissions used: `tabs`, `tabGroups`, `storage`, `alarms` — no host permissions, no page content is read.
