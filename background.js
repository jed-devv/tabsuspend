chrome.commands.onCommand.addListener(async command => {
  if (command !== 'suspend-tab') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) suspendTab(tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'suspendTab') {
    suspendTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'suspendAllTabs') {
    (async () => {
      for (const tabId of msg.tabIds) await suspendTab(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.action === 'activity' && sender.tab?.id) {
    recordActivity(sender.tab.id);
  }
  if (msg.action === 'register' && sender.tab?.id) {
    registerSuspendedTab(sender.tab.id, msg.tid);
  }
  // Fire-and-forget messages (activity, register) send no response; returning
  // false keeps the message channel from staying open and erroring on close.
  return false;
});

// Maps a live tab id to the stable `tid` of the suspended page it hosts.
// tid survives browser restarts (it's in the URL) while tab ids do not, so
// this lets the wake-up handler clean up suspendedData by the stable key.
// The suspended page re-registers on every load, rebuilding the map after a
// restart.
async function registerSuspendedTab(tabId, tid) {
  if (tid == null || tid === '') return;
  const { tabTid = {} } = await chrome.storage.session.get('tabTid');
  tabTid[tabId] = String(tid);
  await chrome.storage.session.set({ tabTid });
}

chrome.tabs.onRemoved.addListener(async tabId => {
  const { tabTid = {} } = await chrome.storage.session.get('tabTid');
  if (tabTid[tabId] != null) {
    delete tabTid[tabId];
    await chrome.storage.session.set({ tabTid });
  }
});

// ── Activity tracking ────────────────────────────────────────
async function recordActivity(tabId) {
  const { lastActivity = {} } = await chrome.storage.session.get('lastActivity');
  lastActivity[tabId] = Date.now();
  await chrome.storage.session.set({ lastActivity });
}

// ── Restore tabs whose suspended page was lost on extension reload ──
chrome.runtime.onStartup.addListener(restoreClosedSuspendedTabs);
chrome.runtime.onInstalled.addListener(details => {
  chrome.alarms.create('tabnap-check', { periodInMinutes: 1 });
  if (details.reason === 'update') restoreClosedSuspendedTabs();
});

async function restoreClosedSuspendedTabs() {
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  if (!Object.keys(suspendedData).length) return;

  const suspendedBase = chrome.runtime.getURL('suspended.html');
  const openWindowIds = new Set((await chrome.windows.getAll()).map(w => w.id));

  // Find which tids are already represented by an open tab (Chrome may
  // have session-restored them itself with the original URL/tid).
  const tabs = await chrome.tabs.query({});
  const openTids = new Set();
  for (const t of tabs) {
    if (!t.url?.startsWith(suspendedBase)) continue;
    const tid = new URL(t.url).searchParams.get('tid');
    if (tid) openTids.add(tid);
  }

  // tid is the stable key — never rekey storage. Only create tabs for
  // tids that aren't already open.
  const toRestore = Object.entries(suspendedData)
    .filter(([tid]) => !openTids.has(tid))
    .sort(([, a], [, b]) => (a.index ?? 0) - (b.index ?? 0));

  const createdForGroup = []; // { newTabId, newWindowId, data }

  for (const [tid, data] of toRestore) {
    if (!data.url) continue;

    const createProps = { url: suspendedBase + '?tid=' + tid, active: false };
    if (data.windowId && openWindowIds.has(data.windowId)) {
      createProps.windowId = data.windowId;
    }
    if (typeof data.index === 'number') createProps.index = data.index;
    if (data.pinned) createProps.pinned = true;

    let newTab;
    try {
      newTab = await chrome.tabs.create(createProps);
    } catch {
      newTab = await chrome.tabs.create({ url: suspendedBase + '?tid=' + tid, active: false });
    }

    if (newTab && (data.groupId ?? -1) !== -1) {
      createdForGroup.push({ newTabId: newTab.id, newWindowId: newTab.windowId, data });
    }
  }

  // Restore tab groups
  const groupBuckets = new Map(); // oldGroupId -> { tabIds[], info, windowId }
  for (const { newTabId, newWindowId, data } of createdForGroup) {
    if (!groupBuckets.has(data.groupId)) {
      groupBuckets.set(data.groupId, { tabIds: [], info: data.groupInfo, windowId: newWindowId });
    }
    groupBuckets.get(data.groupId).tabIds.push(newTabId);
  }

  for (const { tabIds, info, windowId } of groupBuckets.values()) {
    try {
      const newGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      if (info) {
        await chrome.tabGroups.update(newGroupId, {
          title:     info.title  ?? '',
          color:     info.color,
          collapsed: !!info.collapsed,
        });
      }
    } catch {}
  }
}

// Re-create alarm if the service worker restarts and alarm is gone
chrome.alarms.get('tabnap-check', alarm => {
  if (!alarm) chrome.alarms.create('tabnap-check', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'tabnap-check') autoSuspendCheck();
});

async function autoSuspendCheck() {
  const s = await chrome.storage.local.get([
    'autoSuspendMinutes', 'excludePinned', 'excludeAudible',
    'excludeUnsavedForms', 'excludedUrls', 'excludedDomains',
  ]);
  const minutes             = s.autoSuspendMinutes ?? 20;
  const excludePinned       = s.excludePinned       !== false;
  const excludeAudible      = s.excludeAudible      !== false;
  const excludeUnsavedForms = !!s.excludeUnsavedForms;
  const excludedUrls        = s.excludedUrls        || [];
  const excludedDomains     = s.excludedDomains     || [];

  if (!minutes) return; // 0 = disabled

  const threshold    = minutes * 60_000;
  const now          = Date.now();
  const suspendedBase = chrome.runtime.getURL('suspended.html');
  const { lastActivity = {} } = await chrome.storage.session.get('lastActivity');

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.active) continue;
    if (!tab.url || tab.url.startsWith(suspendedBase)) continue;
    if (
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('about:')
    ) continue;
    if (excludePinned  && tab.pinned)  continue;
    if (excludeAudible && tab.audible) continue;
    if (excludedUrls.includes(tab.url)) continue;
    try {
      if (excludedDomains.includes(new URL(tab.url).hostname)) continue;
    } catch {}

    const last = lastActivity[tab.id] ?? tab.lastAccessed ?? now;
    if (now - last < threshold) continue;

    if (excludeUnsavedForms && await tabHasUnsavedInputs(tab.id)) continue;

    await suspendTab(tab.id);
  }
}

function tabHasUnsavedInputs(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { action: 'hasUnsavedInputs' }, response => {
      resolve(chrome.runtime.lastError ? false : !!response);
    });
  });
}

// ── Wake-up: record sleep duration + clean up suspended data ──
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;

  const suspendedBase = chrome.runtime.getURL('suspended.html');
  // Navigating TO (or reloading) the suspended page is the suspension itself,
  // not a wake-up — leave the stored data intact.
  const here = changeInfo.url ?? tab.url ?? '';
  if (here.startsWith(suspendedBase)) return;

  // Only tabs that hosted a registered suspended page can be waking up.
  const { tabTid = {} } = await chrome.storage.session.get('tabTid');
  const tid = tabTid[tabId];
  if (tid == null) return;

  delete tabTid[tabId];
  await chrome.storage.session.set({ tabTid });

  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  const entry = suspendedData[tid];
  if (!entry) return;

  if (entry.suspendedAt) {
    const minutes = Math.floor((Date.now() - entry.suspendedAt) / 60_000);
    if (minutes > 0) {
      const { totalSleepMinutes = 0 } = await chrome.storage.local.get('totalSleepMinutes');
      await chrome.storage.local.set({ totalSleepMinutes: totalSleepMinutes + minutes });
    }
  }

  delete suspendedData[tid];
  await chrome.storage.local.set({ suspendedData });

  recordActivity(tabId);
});

// ── Grayscale favicon ────────────────────────────────────────
async function buildGrayscaleFavicon(favIconUrl) {
  if (!favIconUrl || favIconUrl.startsWith('chrome')) return '';
  try {
    const resp   = await fetch(favIconUrl);
    if (!resp.ok) return '';
    const blob   = await resp.blob();
    const bmp    = await createImageBitmap(blob);
    const oc     = new OffscreenCanvas(32, 32);
    const ctx    = oc.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 32, 32);
    const id = ctx.getImageData(0, 0, 32, 32);
    const d  = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const g    = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * 0.5 | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(id, 0, 0);
    const png = await oc.convertToBlob({ type: 'image/png' });
    const ab  = await png.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'data:image/png;base64,' + btoa(bin);
  } catch {
    return '';
  }
}

// ── Suspend a tab ────────────────────────────────────────────
async function suspendTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;

  const suspendedBase = chrome.runtime.getURL('suspended.html');
  if (
    tab.url.startsWith(suspendedBase) ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('about:')
  ) return;

  const { excludedUrls = [], excludedDomains = [] } =
    await chrome.storage.local.get(['excludedUrls', 'excludedDomains']);
  if (excludedUrls.includes(tab.url)) return;
  try {
    if (excludedDomains.includes(new URL(tab.url).hostname)) return;
  } catch {}

  // Capture video timestamp
  let finalUrl = tab.url;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector('video');
        return video && video.currentTime > 1 ? Math.floor(video.currentTime) : null;
      },
    });
    if (result?.result) {
      const url = new URL(finalUrl);
      url.searchParams.set('t', result.result);
      finalUrl = url.toString();
    }
  } catch {}

  const grayFavicon = await buildGrayscaleFavicon(tab.favIconUrl);

  const groupId = tab.groupId ?? -1;
  let groupInfo = null;
  if (groupId !== -1) {
    try {
      const g = await chrome.tabGroups.get(groupId);
      groupInfo = { title: g.title, color: g.color, collapsed: g.collapsed };
    } catch {}
  }

  // Store tab data in session storage keyed by tabId — avoids putting URLs
  // in query params which Brave Shields flags as a tracker redirect.
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  suspendedData[tabId] = {
    url:         finalUrl,
    title:       tab.title || '',
    favicon:     tab.favIconUrl || '',
    grayFavicon,
    index:       tab.index,
    windowId:    tab.windowId,
    pinned:      tab.pinned,
    groupId,
    groupInfo,
    suspendedAt: Date.now(),
  };
  await chrome.storage.local.set({ suspendedData });

  chrome.tabs.update(tabId, { url: suspendedBase + '?tid=' + tabId });

  recordSuspension();
}

async function recordSuspension() {
  const today     = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();

  const data = await chrome.storage.local.get([
    'lastSuspendDate', 'currentStreak', 'totalRamMB',
  ]);

  const isNewDay      = data.lastSuspendDate !== today;
  const isConsecutive = data.lastSuspendDate === yesterday;

  await chrome.storage.local.set({
    lastSuspendDate: today,
    currentStreak:   isNewDay
      ? (isConsecutive ? (data.currentStreak || 1) + 1 : 1)
      : (data.currentStreak || 1),
    totalRamMB: (data.totalRamMB || 0) + 150,
  });
}
