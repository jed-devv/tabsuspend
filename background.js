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
  tid = String(tid);
  const { tabTid = {} } = await chrome.storage.session.get('tabTid');
  tabTid[tabId] = tid;
  await chrome.storage.session.set({ tabTid });

  // liveTids (persistent) mirrors which suspended pages are currently open.
  // It survives an extension reload — which closes the extension's tabs —
  // so the reload handler knows exactly which tabs to recreate, without
  // touching the stale ghost entries left in suspendedData by closed windows.
  const { liveTids = {} } = await chrome.storage.local.get('liveTids');
  if (!liveTids[tid]) {
    liveTids[tid] = true;
    await chrome.storage.local.set({ liveTids });
  }

  // Refresh stored placement to this session's real window/index, so a stale
  // windowId from a previous session (browser restart) can't misplace the tab
  // on the next restore.
  await refreshPlacement(tabId);
}

async function dropLiveTid(tid) {
  const { liveTids = {} } = await chrome.storage.local.get('liveTids');
  if (liveTids[tid]) {
    delete liveTids[tid];
    await chrome.storage.local.set({ liveTids });
  }
}

// Keep a suspended tab's stored placement (window/index/pinned/group) in sync
// with where the live tab actually is. windowId and index captured once at
// suspend time go stale — across a browser restart windowIds are reassigned, so
// a later restore would dump those tabs into the focused window. Refreshing on
// every page load (register) and on move/attach keeps placement valid for the
// common case: reloading the extension without a browser restart.
async function refreshPlacement(tabId) {
  const { tabTid = {} } = await chrome.storage.session.get('tabTid');
  const tid = tabTid[tabId];
  if (tid == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  const entry = suspendedData[tid];
  if (!entry) return;
  entry.windowId = tab.windowId;
  entry.index    = tab.index;
  entry.pinned   = tab.pinned;
  entry.groupId  = tab.groupId ?? -1;
  delete entry.orphanedAt; // alive again — no longer an orphan
  await chrome.storage.local.set({ suspendedData });
}

chrome.tabs.onMoved.addListener(tabId => refreshPlacement(tabId));
chrome.tabs.onAttached.addListener(tabId => refreshPlacement(tabId));

// Sweep every currently-open suspended page and resync its stored placement to
// the live tab. Reads tid straight from the URL (not the session tabTid map),
// so it also repairs entries left stale by a previous session/browser restart.
async function refreshAllOpenPlacements() {
  const suspendedBase = chrome.runtime.getURL('suspended.html');
  const tabs = await chrome.tabs.query({});
  const { suspendedData = {}, liveTids = {} } =
    await chrome.storage.local.get(['suspendedData', 'liveTids']);
  let changed = false, liveChanged = false;
  for (const t of tabs) {
    if (!t.url?.startsWith(suspendedBase)) continue;
    const tid = new URL(t.url).searchParams.get('tid');
    if (!tid) continue;

    // Reconcile liveTids from ground truth: an open suspended page is live even
    // if its register message was lost (e.g. the worker was asleep at load).
    // Only ever ADD here — removal stays the job of onRemoved, so the brief
    // window where reload closes a tab doesn't wrongly drop it from liveTids.
    if (!liveTids[tid]) { liveTids[tid] = true; liveChanged = true; }

    const entry = suspendedData[tid];
    if (!entry) continue;
    if (entry.windowId !== t.windowId || entry.index !== t.index ||
        entry.pinned !== t.pinned || (entry.groupId ?? -1) !== (t.groupId ?? -1) ||
        entry.orphanedAt != null) {
      entry.windowId = t.windowId;
      entry.index    = t.index;
      entry.pinned   = t.pinned;
      entry.groupId  = t.groupId ?? -1;
      delete entry.orphanedAt; // open right now — not an orphan
      changed = true;
    }
  }
  const patch = {};
  if (changed)     patch.suspendedData = suspendedData;
  if (liveChanged) patch.liveTids      = liveTids;
  if (changed || liveChanged) await chrome.storage.local.set(patch);
}
refreshAllOpenPlacements();

// Drop orphaned suspended-tab data (windows closed and never reopened) once it
// is older than the grace period, so storage can't grow without bound.
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function purgeStaleOrphans() {
  const { suspendedData = {}, liveTids = {} } =
    await chrome.storage.local.get(['suspendedData', 'liveTids']);

  // An entry is alive if it's tracked as live or currently open as a suspended
  // page. Anything else is an orphan (its window closed and never came back).
  const suspendedBase = chrome.runtime.getURL('suspended.html');
  const openTids = new Set();
  for (const t of await chrome.tabs.query({})) {
    if (!t.url?.startsWith(suspendedBase)) continue;
    const tid = new URL(t.url).searchParams.get('tid');
    if (tid) openTids.add(tid);
  }

  const now = Date.now();
  const cutoff = now - ORPHAN_GRACE_MS;
  let changed = false;
  for (const [tid, entry] of Object.entries(suspendedData)) {
    if (!entry) continue;
    const alive = liveTids[tid] || openTids.has(tid);
    if (alive) continue;
    if (entry.orphanedAt == null) {
      // Start the grace clock — also migrates legacy orphans from before this
      // field existed, so they eventually get purged instead of lingering.
      entry.orphanedAt = now;
      changed = true;
    } else if (entry.orphanedAt < cutoff) {
      delete suspendedData[tid];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ suspendedData });
}
purgeStaleOrphans();

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const { tabTid = {} } = await chrome.storage.session.get('tabTid');
  const tid = tabTid[tabId];
  if (tid == null) return;

  delete tabTid[tabId];
  await chrome.storage.session.set({ tabTid });

  // The tab hosting this suspended page is gone, so it is no longer live.
  // Drop it from liveTids in every case (user-close OR window-close) so a
  // later extension reload only recreates tabs that are genuinely still open.
  await dropLiveTid(tid);

  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  if (suspendedData[tid] == null) return;

  if (removeInfo.isWindowClosing) {
    // The window/browser is closing: keep the data so the tab can be restored
    // if the window is reopened, but stamp it as orphaned. The periodic purge
    // drops orphans older than the grace period, so data from windows that are
    // never reopened can't accumulate forever. refreshPlacement clears the
    // stamp if the tab ever comes back to life.
    suspendedData[tid].orphanedAt = Date.now();
  } else {
    // The user closed the tab (or its group) deliberately — forget it so it is
    // never resurrected.
    delete suspendedData[tid];
  }
  await chrome.storage.local.set({ suspendedData });
});

// ── Toolbar badge: number of sleeping tabs ───────────────────
chrome.action.setBadgeBackgroundColor({ color: '#7b6aff' });

async function updateBadge() {
  const base = chrome.runtime.getURL('suspended.html');
  const tabs = await chrome.tabs.query({});
  const n = tabs.filter(t => t.url?.startsWith(base)).length;
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
}

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') updateBadge();
});
chrome.tabs.onCreated.addListener(() => updateBadge());
chrome.tabs.onRemoved.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(updateBadge);
updateBadge();

// ── Activity tracking ────────────────────────────────────────
async function recordActivity(tabId) {
  const { lastActivity = {} } = await chrome.storage.session.get('lastActivity');
  lastActivity[tabId] = Date.now();
  await chrome.storage.session.set({ lastActivity });
}

// ── Restore tabs whose suspended page was lost on extension reload ──
chrome.runtime.onStartup.addListener(restoreClosedSuspendedTabs);
chrome.runtime.onInstalled.addListener(async details => {
  chrome.alarms.create('tabnap-check', { periodInMinutes: 1 });
  createContextMenus();
  // Reloading the extension closes its tabs (the suspended.html pages); recreate
  // the ones that were live. Driven by liveTids, so only genuinely-open tabs come
  // back — ghost entries from previously-closed windows are never resurrected.
  if (details.reason !== 'update') return;

  // Some Chromium browsers (notably Brave) session-restore the extension's tabs
  // themselves on reload, racing our restore: if we recreate a tab before the
  // browser brings it back, we both end up creating it — and our copy lands in
  // the focused window with a stale windowId, scattering tabs across windows.
  // So wait a moment, let the browser settle, THEN restore — by which point the
  // already-restored tabs are seen as open and we recreate nothing.
  // A one-shot alarm is the safety net: a service-worker setTimeout is not
  // guaranteed to survive, so if the worker is killed mid-wait the alarm still
  // runs the reconciliation (restore is idempotent — it dedups open tabs).
  chrome.alarms.create('tabnap-restore', { delayInMinutes: 1 });
  await new Promise(r => setTimeout(r, 2000));
  await restoreClosedSuspendedTabs();
  chrome.alarms.clear('tabnap-restore');
});

// ── Context menu (right-click on a web page) ─────────────────
function createContextMenus() {
  const onPages = {
    contexts: ['page', 'frame', 'link', 'image', 'video', 'audio', 'selection', 'editable'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  };
  chrome.contextMenus.removeAll(() => {
    const msg = k => chrome.i18n.getMessage(k);
    chrome.contextMenus.create({ id: 'tabnap', title: 'TabNap', ...onPages });
    chrome.contextMenus.create({ id: 'suspend-this',   parentId: 'tabnap', title: msg('suspendThisTab'),  ...onPages });
    chrome.contextMenus.create({ id: 'suspend-others', parentId: 'tabnap', title: msg('ctxSuspendOthers'), ...onPages });
    chrome.contextMenus.create({ id: 'tabnap-sep', parentId: 'tabnap', type: 'separator', ...onPages });
    chrome.contextMenus.create({ id: 'never-site', parentId: 'tabnap', title: msg('ctxNeverSite'), ...onPages });
    chrome.contextMenus.create({ id: 'never-url',  parentId: 'tabnap', title: msg('neverUrl'),     ...onPages });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  switch (info.menuItemId) {
    case 'suspend-this':   suspendTab(tab.id);          break;
    case 'suspend-others': suspendOtherTabs(tab.id);    break;
    case 'never-site':     addDomainException(tab.url); break;
    case 'never-url':      addUrlException(tab.url);    break;
  }
});

async function suspendOtherTabs(activeId) {
  const tabs = await chrome.tabs.query({});
  const base = chrome.runtime.getURL('suspended.html');
  const s = await chrome.storage.local.get(
    ['excludePinned', 'excludeAudible', 'excludedUrls', 'excludedDomains']);
  const excludePinned   = s.excludePinned  !== false;
  const excludeAudible  = s.excludeAudible !== false;
  const excludedUrls    = s.excludedUrls    || [];
  const excludedDomains = s.excludedDomains || [];

  for (const t of tabs) {
    if (t.id === activeId || !t.url) continue;
    if (
      t.url.startsWith(base) ||
      t.url.startsWith('chrome://') ||
      t.url.startsWith('chrome-extension://') ||
      t.url.startsWith('about:')
    ) continue;
    if (excludePinned  && t.pinned)  continue;
    if (excludeAudible && t.audible) continue;
    if (excludedUrls.includes(t.url)) continue;
    try {
      if (excludedDomains.includes(new URL(t.url).hostname)) continue;
    } catch {}
    await suspendTab(t.id);
  }
}

async function addUrlException(url) {
  if (!url) return;
  const { excludedUrls = [] } = await chrome.storage.local.get('excludedUrls');
  if (!excludedUrls.includes(url)) {
    excludedUrls.push(url);
    await chrome.storage.local.set({ excludedUrls });
  }
}

async function addDomainException(url) {
  let domain = '';
  try { domain = new URL(url).hostname; } catch { return; }
  if (!domain) return;
  const { excludedDomains = [] } = await chrome.storage.local.get('excludedDomains');
  if (!excludedDomains.includes(domain)) {
    excludedDomains.push(domain);
    await chrome.storage.local.set({ excludedDomains });
  }
}

async function restoreClosedSuspendedTabs() {
  const { suspendedData = {}, liveTids = {} } =
    await chrome.storage.local.get(['suspendedData', 'liveTids']);
  if (!Object.keys(liveTids).length) return;

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

  // Only recreate tabs that were live just before the reload/restart and
  // aren't already open. Driving this from liveTids (not all of suspendedData)
  // is what prevents resurrecting ghost entries from previously-closed windows.
  const toRestore = Object.keys(liveTids)
    .filter(tid => !openTids.has(tid) && suspendedData[tid]?.url)
    .map(tid => [tid, suspendedData[tid]])
    .sort(([, a], [, b]) => (a.index ?? 0) - (b.index ?? 0));

  const createdForGroup = [];  // { newTabId, newWindowId, data }
  const toPosition      = [];  // { tabId, windowId, index } — ungrouped tabs to place

  // 1) Create every tab WITHOUT an index. Passing a stale absolute index to
  //    chrome.tabs.create can throw (out of range, or a pinned tab landing in
  //    the unpinned region), which previously dropped the tab at the end and
  //    scrambled the order. We pin at creation (so pinned tabs land in the
  //    pinned strip) and reposition afterwards with the forgiving tabs.move.
  for (const [tid, data] of toRestore) {
    if (!data.url) continue;

    const createProps = { url: suspendedBase + '?tid=' + tid, active: false };
    if (data.windowId && openWindowIds.has(data.windowId)) {
      createProps.windowId = data.windowId;
    }
    if (data.pinned) createProps.pinned = true;

    let newTab;
    try {
      newTab = await chrome.tabs.create(createProps);
    } catch {
      continue;
    }
    if (!newTab) continue;

    if ((data.groupId ?? -1) !== -1) {
      // Grouped tabs are positioned by the grouping step below (a group is
      // always contiguous), so don't fight it with an individual move.
      createdForGroup.push({ newTabId: newTab.id, newWindowId: newTab.windowId, data });
    } else if (typeof data.index === 'number') {
      toPosition.push({ tabId: newTab.id, windowId: newTab.windowId, index: data.index });
    }
  }

  // 2) Reposition ungrouped tabs to their original absolute index, per window,
  //    in ascending order. Moving ascending means an already-placed lower index
  //    is never disturbed by a later, higher move. tabs.move clamps an
  //    out-of-range index to the end instead of throwing.
  toPosition.sort((a, b) => a.index - b.index);
  for (const { tabId, index } of toPosition) {
    try {
      await chrome.tabs.move(tabId, { index });
    } catch {}
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
  if (alarm.name === 'tabnap-check')   { autoSuspendCheck(); refreshAllOpenPlacements(); purgeStaleOrphans(); }
  if (alarm.name === 'tabnap-restore') restoreClosedSuspendedTabs();
});

async function autoSuspendCheck() {
  const s = await chrome.storage.local.get([
    'autoSuspendMinutes', 'excludePinned', 'excludeAudible',
    'excludeUnsavedForms', 'excludeActiveMedia', 'excludedUrls', 'excludedDomains',
  ]);
  const minutes             = s.autoSuspendMinutes ?? 20;
  const excludePinned       = s.excludePinned       !== false;
  const excludeAudible      = s.excludeAudible      !== false;
  const excludeUnsavedForms = !!s.excludeUnsavedForms;
  const excludeActiveMedia  = s.excludeActiveMedia  !== false;
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
    if (excludeActiveMedia  && await tabHasActiveMedia(tab.id))   continue;

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

function tabHasActiveMedia(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { action: 'hasActiveMediaStream' }, response => {
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

  await dropLiveTid(tid);

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
}
