import { assignCategory, categoryColorPalette, classroomCourseId, classroomCourseName, classifyTab, clusterBySharedWords, courseLabel, domainLabel } from "./categorizer.js";

const DEFAULT_SETTINGS = {
  autoSortEnabled: true,
  autoSaveIntervalMinutes: 10,
  autoRestoreOnStartup: false,
  maxClosedArchive: 500,
  ignorePinnedTabs: true,
  smartGroupingEnabled: true,
  groupSameSiteTabs: true,
  groupRelatedTabs: true,
  minimumSmartGroupSize: 2,
  autoArchiveDuplicates: false,
  focusDistractionsEnabled: true,
  staleTabDays: 14,
  autoCollapseFocusGroup: true,
  groupClassworkByCourse: true
};

// In-memory cache so we still know a tab's url/title/category after it's
// removed (chrome.tabs.onRemoved gives you only the id).
const tabCache = new Map(); // tabId -> { url, title, windowId, category }
const manualUngroup = new Set(); // tabIds the user pulled out of a group on purpose
const sortTimers = new Map();

function canonicalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key)) url.searchParams.delete(key);
    }
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch { return rawUrl; }
}

async function recordTabActivity(tab) {
  if (!tab?.url || tab.url.startsWith("chrome://")) return;
  const stored = await chrome.storage.local.get("activityByUrl");
  const activityByUrl = stored.activityByUrl || {};
  activityByUrl[canonicalUrl(tab.url)] = Date.now();
  await chrome.storage.local.set({ activityByUrl });
}

async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function getCustomRules() {
  const stored = await chrome.storage.sync.get("customRules");
  return stored.customRules || [];
}

async function learnClassroomContexts(tabs) {
  const stored = await chrome.storage.local.get("classroomContexts");
  const classroomContexts = stored.classroomContexts || {};
  let changed = false;
  for (const tab of tabs) {
    const id = classroomCourseId(tab.url || "");
    const name = classroomCourseName(tab);
    if (id && name && classroomContexts[id] !== name) {
      classroomContexts[id] = name;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ classroomContexts });
  return classroomContexts;
}

function matchingClassroomContext(tab, contexts) {
  const direct = contexts[classroomCourseId(tab.url || "")];
  if (direct) return direct;
  const title = (tab.title || "").toLowerCase();
  return Object.values(contexts).find(name => name.length >= 4 && title.includes(name.toLowerCase())) || "";
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  chrome.storage.sync.set({ settings });
  chrome.alarms.create("autosave", { periodInMinutes: settings.autoSaveIntervalMinutes });
  await primeCache();
  await sortAllWindows();
});

chrome.runtime.onStartup.addListener(async () => {
  await primeCache();
  const settings = await getSettings();
  if (settings.autoRestoreOnStartup) {
    await maybeRestoreLastSession();
  }
  if (settings.autoSortEnabled) await sortAllWindows();
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

function scheduleWindowSort(windowId) {
  clearTimeout(sortTimers.get(windowId));
  sortTimers.set(windowId, setTimeout(() => {
    sortTimers.delete(windowId);
    sortWindow(windowId);
  }, 750));
}

async function smartGroupsFor(tabs, settings) {
  const customRules = await getCustomRules();
  const classroomContexts = await learnClassroomContexts(tabs);
  const groups = new Map();
  const uncategorized = [];
  for (const tab of tabs) {
    if (manualUngroup.has(tab.id) || !tab.url || tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") || (settings.ignorePinnedTabs && tab.pinned)) continue;
    const classroomContext = settings.groupClassworkByCourse ? matchingClassroomContext(tab, classroomContexts) : "";
    const category = classifyTab(tab, customRules) || (classroomContext ? { name: "Classes & Learning", color: "yellow" } : null);
    if (category) {
      const course = classroomContext || (settings.groupClassworkByCourse && category.name === "Classes & Learning" ? courseLabel(tab) : "");
      if (course) {
        const key = `course:${course}`;
        if (!groups.has(key)) groups.set(key, { name: course, color: "yellow", tabs: [] });
        groups.get(key).tabs.push(tab);
        continue;
      }
      const key = `category:${category.name}`;
      if (!groups.has(key)) groups.set(key, { name: category.name, color: category.color, tabs: [] });
      groups.get(key).tabs.push(tab);
    } else {
      uncategorized.push(tab);
    }
  }
  if (settings.groupSameSiteTabs) {
    const byDomain = new Map();
    for (const tab of uncategorized) {
      const label = domainLabel(tab.url);
      if (!label) continue;
      if (!byDomain.has(label)) byDomain.set(label, []);
      byDomain.get(label).push(tab);
    }
    for (const [label, domainTabs] of byDomain) {
      if (domainTabs.length >= settings.minimumSmartGroupSize) {
        groups.set(`domain:${label}`, { name: label[0].toUpperCase() + label.slice(1), color: "grey", tabs: domainTabs });
      }
    }
  }
  if (settings.groupRelatedTabs) {
    const claimed = new Set([...groups.values()].flatMap(group => group.tabs.map(tab => tab.id)));
    const clusters = clusterBySharedWords(uncategorized.filter(tab => !claimed.has(tab.id)));
    const byLabel = new Map();
    for (const tab of uncategorized) {
      const label = clusters.get(tab.id);
      if (!label) continue;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(tab);
    }
    const colors = categoryColorPalette();
    let index = 0;
    for (const [label, clusterTabs] of byLabel) {
      if (clusterTabs.length >= settings.minimumSmartGroupSize) {
        groups.set(`topic:${label}`, { name: label, color: colors[index++ % colors.length], tabs: clusterTabs });
      }
    }
  }
  return groups;
}

async function sortWindow(windowId) {
  const settings = await getSettings();
  if (!settings.autoSortEnabled) return;
  const tabs = await chrome.tabs.query({ windowId });
  if (!settings.smartGroupingEnabled) {
    for (const tab of tabs) await sortSingleTab(tab);
    return;
  }
  const groups = await smartGroupsFor(tabs, settings);
  for (const group of groups.values()) {
    for (const tab of group.tabs) {
      try {
        await findOrCreateGroup(windowId, group.name, group.color, tab.id);
        tabCache.set(tab.id, { url: tab.url, title: tab.title, windowId, category: group.name });
      } catch { /* Tab was removed or the window changed while sorting. */ }
    }
  }
  await archiveDuplicateTabs(windowId);
}

async function sortAllWindows() {
  const windows = await chrome.windows.getAll();
  await Promise.all(windows.map(win => sortWindow(win.id)));
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
  scheduleWindowSort(tab.windowId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await recordTabActivity(await chrome.tabs.get(tabId));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    manualUngroup.delete(tabId); // fresh navigation clears the manual opt-out
    await sortSingleTab(tab);
    scheduleWindowSort(tab.windowId);
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

chrome.tabs.onMoved.addListener((tabId, moveInfo) => scheduleWindowSort(moveInfo.windowId));

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

async function archiveDuplicateTabs(windowId, force = false) {
  const settings = await getSettings();
  if (!force && !settings.autoArchiveDuplicates) return { archived: 0 };
  const tabs = await chrome.tabs.query({ windowId });
  const byUrl = new Map();
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith("chrome://")) continue;
    const url = canonicalUrl(tab.url);
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(tab);
  }
  const duplicateIds = [];
  for (const matchingTabs of byUrl.values()) {
    if (matchingTabs.length < 2) continue;
    // Prefer the active tab, then a pinned tab, then the newest tab. This
    // makes cleanup predictable and never closes a protected tab.
    const keep = matchingTabs.find(tab => tab.active) || matchingTabs.find(tab => tab.pinned) || matchingTabs.at(-1);
    for (const tab of matchingTabs) {
      if (tab.id !== keep.id && !tab.pinned && !tab.active && !tab.audible) duplicateIds.push(tab.id);
    }
  }
  if (duplicateIds.length) await chrome.tabs.remove(duplicateIds);
  return { archived: duplicateIds.length };
}

async function startFocusMode(windowId) {
  const settings = await getSettings();
  if (!settings.focusDistractionsEnabled) return { moved: 0 };
  const tabs = await chrome.tabs.query({ windowId });
  const customRules = await getCustomRules();
  const distractions = tabs.filter(tab => {
    const category = classifyTab(tab, customRules)?.name;
    return !tab.active && !tab.pinned && !tab.audible && ["Social", "Video & Streaming", "Shopping"].includes(category);
  });
  if (!distractions.length) return { moved: 0 };
  const groupId = await chrome.tabs.group({ tabIds: distractions.map(tab => tab.id), windowId });
  await chrome.tabGroups.update(groupId, { title: "Later", color: "grey", collapsed: settings.autoCollapseFocusGroup });
  return { moved: distractions.length };
}

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
        await sortWindow(win.id);
        sendResponse({ ok: true });
        break;
      }
      case "TIDY_CURRENT_WINDOW": {
        const win = await chrome.windows.getCurrent();
        await sortWindow(win.id);
        const result = await archiveDuplicateTabs(win.id, true);
        sendResponse({ ok: true, ...result });
        break;
      }
      case "START_FOCUS_MODE": {
        const win = await chrome.windows.getCurrent();
        const result = await startFocusMode(win.id);
        sendResponse({ ok: true, ...result });
        break;
      }
      case "GET_TAB_INSIGHTS": {
        const win = await chrome.windows.getCurrent();
        const tabs = await chrome.tabs.query({ windowId: win.id });
        const customRules = await getCustomRules();
        const stored = await chrome.storage.local.get("activityByUrl");
        const activityByUrl = stored.activityByUrl || {};
        const urls = new Set();
        let duplicates = 0;
        let categorized = 0;
        let stale = 0;
        const staleBefore = Date.now() - (await getSettings()).staleTabDays * 24 * 60 * 60 * 1000;
        for (const tab of tabs) {
          if (classifyTab(tab, customRules)) categorized++;
          const url = canonicalUrl(tab.url);
          if (urls.has(url)) duplicates++;
          else urls.add(url);
          if (activityByUrl[url] && activityByUrl[url] < staleBefore) stale++;
        }
        sendResponse({ ok: true, total: tabs.length, categorized, duplicates, stale, ungrouped: tabs.filter(t => t.groupId === -1).length });
        break;
      }
      case "SEARCH_TABS": {
        const query = (message.query || "").trim().toLowerCase();
        if (!query) { sendResponse({ ok: true, results: [] }); break; }
        const [tabs, local] = await Promise.all([chrome.tabs.query({}), chrome.storage.local.get(["closedArchive", "sessions"])]);
        const matches = value => `${value.title || ""} ${value.url || ""} ${value.name || ""}`.toLowerCase().includes(query);
        const results = [
          ...tabs.filter(matches).slice(0, 12).map(tab => ({ kind: "tab", id: tab.id, windowId: tab.windowId, title: tab.title || tab.url, url: tab.url })),
          ...(local.closedArchive || []).filter(matches).slice(0, 8).map(entry => ({ kind: "archive", title: entry.title || entry.url, url: entry.url })),
          ...(local.sessions || []).filter(matches).slice(0, 5).map(session => ({ kind: "session", title: session.name, session }))
        ];
        sendResponse({ ok: true, results });
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
        if (updated.autoSortEnabled) await sortAllWindows();
        sendResponse({ ok: true, settings: updated });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  return true; // keep the message channel open for the async response
});
