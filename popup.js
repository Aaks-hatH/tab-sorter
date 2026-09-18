const COLOR_HEX = {
  grey: "#5f6368", blue: "#1a73e8", red: "#d93025", yellow: "#f9ab00",
  green: "#188038", pink: "#d01884", purple: "#a142f4", cyan: "#007b83",
  orange: "#fa903e"
};

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function faviconFor(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return "";
  }
}

function timeAgo(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// ---------- Tab switching ----------
document.querySelectorAll(".tabbtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbtn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "sessions") renderSessions();
    if (btn.dataset.tab === "archive") renderArchive();
  });
});

// ---------- Live panel ----------
async function renderLive() {
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  const groupById = new Map(groups.map(g => [g.id, g]));

  const buckets = new Map(); // label -> { color, tabs: [] }
  const ungrouped = [];

  for (const tab of tabs) {
    const group = groupById.get(tab.groupId);
    if (group) {
      const label = group.title || "Untitled group";
      if (!buckets.has(label)) buckets.set(label, { color: group.color, tabs: [] });
      buckets.get(label).tabs.push(tab);
      buckets.get(label).groupId = group.id;
      buckets.get(label).collapsed = group.collapsed;
    } else {
      ungrouped.push(tab);
    }
  }

  const container = document.getElementById("liveGroups");
  container.innerHTML = "";

  if (tabs.length === 0) {
    container.innerHTML = `<div class="empty-state">No tabs in this window.</div>`;
    return;
  }

  for (const [label, data] of buckets) {
    container.appendChild(renderGroupBlock(label, data.color, data.tabs, data.groupId, data.collapsed));
  }
  if (ungrouped.length) {
    container.appendChild(renderGroupBlock("Ungrouped", "grey", ungrouped));
  }
}

async function renderInsights() {
  const insight = await send({ type: "GET_TAB_INSIGHTS" });
  const container = document.getElementById("insights");
  if (!insight?.ok) return;
  container.innerHTML = `
    <div><strong>${insight.total}</strong><span> open</span></div>
    <div><strong>${insight.categorized}</strong><span> recognized</span></div>
    <div><strong>${insight.duplicates}</strong><span> duplicates · ${insight.stale} stale</span></div>
  `;
}

function renderGroupBlock(label, color, tabs, groupId, collapsed = false) {
  const block = document.createElement("div");
  block.className = "group-block";

  const heading = document.createElement("div");
  heading.className = "group-heading";
  heading.innerHTML = `
    <span class="color-dot" style="background:${COLOR_HEX[color] || "#888"}"></span>
    <span>${escapeHtml(label)}</span>
    <span class="group-count">${tabs.length}</span>
    ${groupId !== undefined ? `<button class="group-delete" title="Remove group (keep tabs open)">×</button>` : ""}
  `;
  if (groupId !== undefined) {
    heading.querySelector(".group-delete").addEventListener("click", async (event) => {
      event.stopPropagation();
      await send({ type: "DELETE_GROUP", groupId });
      renderLive();
      renderInsights();
    });
  }
  block.appendChild(heading);

  if (collapsed) return block;
  for (const tab of tabs) {
    const item = document.createElement("div");
    item.className = "tab-item";
    item.innerHTML = `
      <img class="tab-favicon" src="${faviconFor(tab.url)}" />
      <span class="tab-title">${escapeHtml(tab.title || tab.url)}</span>
    `;
    item.addEventListener("click", () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    });
    block.appendChild(item);
  }
  return block;
}

document.getElementById("sortNowBtn").addEventListener("click", async () => {
  await send({ type: "SORT_CURRENT_WINDOW" });
  renderLive();
  renderInsights();
});

document.getElementById("tidyNowBtn").addEventListener("click", async (event) => {
  const result = await send({ type: "TIDY_CURRENT_WINDOW" });
  event.currentTarget.textContent = result.archived ? `✓ ${result.archived} duplicate${result.archived === 1 ? "" : "s"} closed` : "✓ Tidy";
  setTimeout(() => (event.currentTarget.textContent = "✦ Tidy"), 1800);
  renderLive();
  renderInsights();
});

document.getElementById("collapseGroupsBtn").addEventListener("click", async (event) => {
  await send({ type: "COLLAPSE_UNUSED_GROUPS" });
  event.currentTarget.textContent = "✓";
  setTimeout(() => (event.currentTarget.textContent = "▰"), 1200);
  renderLive();
});

document.getElementById("focusBtn").addEventListener("click", async (event) => {
  const result = await send({ type: "START_FOCUS_MODE" });
  event.currentTarget.textContent = result.moved ? `✓${result.moved}` : "◐";
  setTimeout(() => (event.currentTarget.textContent = "◐"), 1800);
  renderLive();
});

let searchTimer;
document.getElementById("tabSearchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderSearchResults(event.target.value), 150);
});

async function renderSearchResults(query) {
  const container = document.getElementById("searchResults");
  if (!query.trim()) { container.innerHTML = ""; return; }
  const response = await send({ type: "SEARCH_TABS", query });
  container.innerHTML = "";
  for (const result of response.results || []) {
    const item = document.createElement("button");
    item.className = "search-result";
    item.innerHTML = `<span>${escapeHtml(result.title)}</span><small>${result.kind}</small>`;
    item.addEventListener("click", async () => {
      if (result.kind === "tab") {
        await chrome.tabs.update(result.id, { active: true });
        await chrome.windows.update(result.windowId, { focused: true });
      } else if (result.kind === "archive") {
        await chrome.tabs.create({ url: result.url });
      } else {
        await send({ type: "RESTORE_SESSION", session: result.session });
      }
      container.innerHTML = "";
      document.getElementById("tabSearchInput").value = "";
    });
    container.appendChild(item);
  }
  if (!container.children.length) container.innerHTML = `<div class="empty-state compact-empty">No matching tabs, sessions, or archive entries.</div>`;
}

// ---------- Sessions panel ----------
async function renderSessions() {
  const stored = await chrome.storage.local.get("sessions");
  const sessions = stored.sessions || [];
  const list = document.getElementById("sessionsList");
  list.innerHTML = "";

  if (!sessions.length) {
    list.innerHTML = `<div class="empty-state">No saved sessions yet. Save your current tabs above.</div>`;
    return;
  }

  for (const session of sessions) {
    const tabCount = session.windows.reduce((sum, w) => sum + w.tabs.length, 0);
    const card = document.createElement("div");
    card.className = "session-card";
    card.innerHTML = `
      <div class="session-top">
        <span class="session-name">${escapeHtml(session.name)}</span>
        <span class="session-meta">${timeAgo(session.savedAt)}</span>
      </div>
      <div class="session-meta">${session.windows.length} window(s) · ${tabCount} tabs</div>
      <div class="session-actions">
        <button data-action="restore">Restore</button>
        <button data-action="delete">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="restore"]').addEventListener("click", async () => {
      await send({ type: "RESTORE_SESSION", session });
    });
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      await send({ type: "DELETE_SESSION", savedAt: session.savedAt });
      renderSessions();
    });
    list.appendChild(card);
  }
}

document.getElementById("saveSessionBtn").addEventListener("click", async () => {
  const input = document.getElementById("sessionNameInput");
  const name = input.value.trim() || undefined;
  await send({ type: "SAVE_SESSION_NOW", name });
  input.value = "";
  renderSessions();
});

// ---------- Closed archive panel ----------
async function renderArchive() {
  const stored = await chrome.storage.local.get("closedArchive");
  const archive = stored.closedArchive || [];
  const list = document.getElementById("archiveList");
  list.innerHTML = "";

  if (!archive.length) {
    list.innerHTML = `<div class="empty-state">Nothing closed yet. Closed tabs land here automatically, organized by category.</div>`;
    return;
  }

  for (const entry of archive.slice(0, 100)) {
    const item = document.createElement("div");
    item.className = "archive-item";
    item.innerHTML = `
      <img class="tab-favicon" src="${faviconFor(entry.url)}" />
      <div class="archive-info">
        <div class="archive-title">${escapeHtml(entry.title)}</div>
        <div class="archive-meta">${escapeHtml(entry.category)} · ${timeAgo(entry.closedAt)}</div>
      </div>
    `;
    item.addEventListener("click", () => {
      chrome.tabs.create({ url: entry.url });
    });
    list.appendChild(item);
  }
}

document.getElementById("clearArchiveBtn").addEventListener("click", async () => {
  await send({ type: "CLEAR_CLOSED_ARCHIVE" });
  renderArchive();
});

// ---------- Settings panel ----------
async function renderSettings() {
  const stored = await chrome.storage.sync.get("settings");
  const settings = stored.settings || {};
  document.getElementById("autoSortEnabled").checked = settings.autoSortEnabled ?? true;
  document.getElementById("autoRestoreOnStartup").checked = settings.autoRestoreOnStartup ?? false;
  document.getElementById("autoSaveEnabled").checked = settings.autoSaveEnabled ?? false;
  document.getElementById("saveClosedTabs").checked = settings.saveClosedTabs ?? false;
  document.getElementById("autoSaveIntervalMinutes").value = String(settings.autoSaveIntervalMinutes ?? 10);
  for (const id of ["smartGroupingEnabled", "groupSameSiteTabs", "groupRelatedTabs", "groupClassworkByCourse", "schoolworkDetectionEnabled", "ignorePinnedTabs", "autoArchiveDuplicates", "focusDistractionsEnabled", "autoCollapseFocusGroup", "autoCollapseUnusedGroups"]) {
    document.getElementById(id).checked = settings[id] ?? (id !== "autoArchiveDuplicates");
  }
  document.getElementById("minimumSmartGroupSize").value = String(settings.minimumSmartGroupSize ?? 2);
  document.getElementById("staleTabDays").value = String(settings.staleTabDays ?? 14);
  document.getElementById("unusedGroupMinutes").value = String(settings.unusedGroupMinutes ?? 30);
  document.getElementById("maxAutoGroupsPerWindow").value = String(settings.maxAutoGroupsPerWindow ?? 8);
}

for (const id of ["autoSortEnabled", "autoRestoreOnStartup", "autoSaveEnabled", "saveClosedTabs", "smartGroupingEnabled", "groupSameSiteTabs", "groupRelatedTabs", "groupClassworkByCourse", "schoolworkDetectionEnabled", "ignorePinnedTabs", "autoArchiveDuplicates", "focusDistractionsEnabled", "autoCollapseFocusGroup", "autoCollapseUnusedGroups"]) {
  document.getElementById(id).addEventListener("change", (e) => {
    send({ type: "UPDATE_SETTINGS", settings: { [id]: e.target.checked } });
  });
}
for (const id of ["autoSaveIntervalMinutes", "minimumSmartGroupSize", "unusedGroupMinutes", "maxAutoGroupsPerWindow"]) {
  document.getElementById(id).addEventListener("change", (e) => {
    send({ type: "UPDATE_SETTINGS", settings: { [id]: Number(e.target.value) } });
  });
}
document.getElementById("staleTabDays").addEventListener("change", (e) => {
  send({ type: "UPDATE_SETTINGS", settings: { staleTabDays: Number(e.target.value) } });
  renderInsights();
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

renderLive();
renderInsights();
renderSettings();
