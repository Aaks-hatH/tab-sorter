import { assignCategory } from "./categorizer.js";

const DEFAULT_SETTINGS = {
  autoSortEnabled: true,
  autoSaveIntervalMinutes: 10,
  autoRestoreOnStartup: false,
  maxClosedArchive: 500,
  ignorePinnedTabs: true
};

// In-memory cache so we still know a tab's url/title/category after it's
// removed (chrome.tabs.onRemoved gives you only the id).
const tabCache = new Map(); // tabId -> { url, title, windowId, category }
const manualUngroup = new Set(); // tabIds the user pulled out of a group on purpose

async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function getCustomRules() {
  const stored = await chrome.storage.sync.get("customRules");
  return stored.customRules || [];
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  chrome.storage.sync.set({ settings });
  chrome.alarms.create("autosave", { periodInMinutes: settings.autoSaveIntervalMinutes });
  await primeCache();
});

chrome.runtime.onStartup.addListener(async () => {
  await primeCache();
  const settings = await getSettings();
  if (settings.autoRestoreOnStartup) {
    await maybeRestoreLastSession();
  }
});

async function primeCache() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    tabCache.set(tab.id, {
      url: tab.url,
      title: tab.title,
      windowId: tab.windowId,
      category: null
    });
  }
}

// ---------- Live sorting ----------

async function findOrCreateGroup(windowId, categoryName, color, tabId) {
  const groups = await chrome.tabGroups.query({ windowId, title: categoryName });
  if (groups.length > 0) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    return groups[0].id;
  }
  const newGroupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(newGroupId, { title: categoryName, color });
  return newGroupId;
}

async function sortSingleTab(tab) {
  const settings = await getSettings();
  if (!settings.autoSortEnabled) return;
  if (settings.ignorePinnedTabs && tab.pinned) return;
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return;
  if (manualUngroup.has(tab.id)) return;

  const customRules = await getCustomRules();
  const category = assignCategory(tab, customRules);
  if (!category) return; // leave uncategorized tabs alone; user can still see them in the popup

  const cached = tabCache.get(tab.id);
  if (cached && cached.category === category.name && tab.groupId && tab.groupId !== -1) {
    return; // already correctly grouped, avoid regroup thrash
  }

  try {
    await findOrCreateGroup(tab.windowId, category.name, category.color, tab.id);
  } catch (e) {
    // tab may have closed mid-flight; ignore
  }

  tabCache.set(tab.id, { url: tab.url, title: tab.title, windowId: tab.windowId, category: category.name });
}

chrome.tabs.onCreated.addListener((tab) => {
  tabCache.set(tab.id, { url: tab.url, title: tab.title, windowId: tab.windowId, category: null });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    manualUngroup.delete(tabId); // fresh navigation clears the manual opt-out
    await sortSingleTab(tab);
  }
  if (changeInfo.groupId === -1) {
    // user (or Chrome) pulled this tab out of its group without a navigation
    manualUngroup.add(tabId);
  }
  if (changeInfo.title || changeInfo.url) {
    const cached = tabCache.get(tabId) || {};
    tabCache.set(tabId, { ...cached, url: tab.url ?? cached.url, title: tab.title ?? cached.title, windowId: tab.windowId });
  }
});

// ---------- Closed-tab archive ----------

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const cached = tabCache.get(tabId);
  tabCache.delete(tabId);
  manualUngroup.delete(tabId);
  if (!cached || !cached.url || cached.url.startsWith("chrome://")) return;

  const settings = await getSettings();
  const stored = await chrome.storage.local.get("closedArchive");
  const archive = stored.closedArchive || [];

  archive.unshift({
    url: cached.url,
    title: cached.title || cached.url,
    category: cached.category || "Uncategorized",
    closedAt: Date.now()
  });

  // de-dupe by URL, keep most recent
  const seen = new Set();
  const deduped = archive.filter(entry => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });

  await chrome.storage.local.set({
    closedArchive: deduped.slice(0, settings.maxClosedArchive)
  });
});

// ---------- Session snapshots ----------

async function snapshotAllWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  const customRules = await getCustomRules();
  const snapshot = [];
  for (const win of windows) {
    const tabs = (win.tabs || [])
      .filter(t => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
      .map(t => ({
        url: t.url,
        title: t.title,
        pinned: t.pinned,
        category: assignCategory(t, customRules)?.name || "Uncategorized"
      }));
    if (tabs.length) snapshot.push({ tabs });
  }
  return snapshot;
}

async function saveNamedSession(name) {
  const snapshot = await snapshotAllWindows();
  const stored = await chrome.storage.local.get("sessions");
  const sessions = stored.sessions || [];
  sessions.unshift({ name, savedAt: Date.now(), windows: snapshot });
  await chrome.storage.local.set({ sessions: sessions.slice(0, 100) });
  return sessions[0];
}

async function autoSaveLastSession() {
  const snapshot = await snapshotAllWindows();
  await chrome.storage.local.set({ lastSession: { savedAt: Date.now(), windows: snapshot } });
}

async function restoreSession(session) {
  const customRules = await getCustomRules();
  for (const win of session.windows) {
    if (!win.tabs.length) continue;
    const newWindow = await chrome.windows.create({ url: win.tabs[0].url });
    const createdTabIds = [newWindow.tabs[0].id];
    for (let i = 1; i < win.tabs.length; i++) {
      const t = await chrome.tabs.create({ windowId: newWindow.id, url: win.tabs[i].url, active: false });
      createdTabIds.push(t.id);
    }
    // group restored tabs by their saved category
    const byCategory = new Map();
    win.tabs.forEach((t, idx) => {
      const cat = t.category || "Uncategorized";
      if (cat === "Uncategorized") return;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(createdTabIds[idx]);
    });
    for (const [cat, tabIds] of byCategory) {
      const rule = customRules.find(r => r.category === cat);
      const color = rule?.color || "grey";
      try {
        const groupId = await chrome.tabs.group({ tabIds, windowId: newWindow.id });
        await chrome.tabGroups.update(groupId, { title: cat, color });
      } catch { /* ignore */ }
    }
  }
}

async function maybeRestoreLastSession() {
  const stored = await chrome.storage.local.get("lastSession");
  if (stored.lastSession && stored.lastSession.windows.length) {
    await restoreSession(stored.lastSession);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "autosave") {
    autoSaveLastSession();
  }
});

// Also snapshot whenever an entire window closes, so "closed while open" is
// never lost even between alarm intervals.
chrome.windows.onRemoved.addListener(() => {
  autoSaveLastSession();
});

// ---------- Messaging with popup / options ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "SORT_CURRENT_WINDOW": {
        const win = await chrome.windows.getCurrent();
        const tabs = await chrome.tabs.query({ windowId: win.id });
        for (const tab of tabs) await sortSingleTab(tab);
        sendResponse({ ok: true });
        break;
      }
      case "SAVE_SESSION_NOW": {
        const session = await saveNamedSession(message.name || `Session ${new Date().toLocaleString()}`);
        sendResponse({ ok: true, session });
        break;
      }
      case "RESTORE_SESSION": {
        await restoreSession(message.session);
        sendResponse({ ok: true });
        break;
      }
      case "DELETE_SESSION": {
        const stored = await chrome.storage.local.get("sessions");
        const sessions = (stored.sessions || []).filter(s => s.savedAt !== message.savedAt);
        await chrome.storage.local.set({ sessions });
        sendResponse({ ok: true });
        break;
      }
      case "CLEAR_CLOSED_ARCHIVE": {
        await chrome.storage.local.set({ closedArchive: [] });
        sendResponse({ ok: true });
        break;
      }
      case "UPDATE_SETTINGS": {
        const current = await getSettings();
        const updated = { ...current, ...message.settings };
        await chrome.storage.sync.set({ settings: updated });
        chrome.alarms.create("autosave", { periodInMinutes: updated.autoSaveIntervalMinutes });
        sendResponse({ ok: true, settings: updated });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  return true; // keep the message channel open for the async response
});
