// ── i18n ─────────────────────────────────────────────────────
const t = (k, ...subs) => chrome.i18n.getMessage(k, subs.length ? subs.map(String) : undefined);
const plural = (n, oneKey, otherKey) => t(n === 1 ? oneKey : otherKey, n);

document.querySelectorAll('[data-i18n]').forEach(el => {
  const m = t(el.dataset.i18n);
  if (m) el.textContent = m;
});
document.querySelectorAll('[data-i18n-title]').forEach(el => {
  const m = t(el.dataset.i18nTitle);
  if (m) el.title = m;
});

// ── Starfield ───────────────────────────────────────────────
const canvas = document.getElementById('starfield');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width  = document.body.offsetWidth  || 320;
  canvas.height = document.body.offsetHeight || 450;
}
resizeCanvas();

const STARS = Array.from({ length: 55 }, () => ({
  x:     Math.random() * 320,
  y:     Math.random() * 500,
  r:     Math.random() * 1.1 + 0.25,
  speed: Math.random() * 0.006 + 0.002,
  phase: Math.random() * Math.PI * 2,
  warm:  Math.random() > 0.6,
}));

function paintStars(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  STARS.forEach(s => {
    const alpha = 0.15 + 0.55 * Math.abs(Math.sin(t * s.speed + s.phase));
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = s.warm
      ? `rgba(240, 201, 74, ${alpha})`
      : `rgba(184, 168, 255, ${alpha})`;
    ctx.fill();
  });
  requestAnimationFrame(paintStars);
}
requestAnimationFrame(paintStars);

// ── Current tab ─────────────────────────────────────────────
let currentTab = null;
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  currentTab = tab;

  const nameEl     = document.getElementById('tab-name');
  const favEl      = document.getElementById('tab-fav');
  const fallbackEl = document.getElementById('tab-fav-fallback');

  nameEl.textContent = tab.title || t('untitledTab');

  if (tab.favIconUrl) {
    favEl.src    = tab.favIconUrl;
    favEl.hidden = false;
    fallbackEl.hidden = true;
    favEl.onerror = () => { favEl.hidden = true; fallbackEl.hidden = false; };
  }

  const base = chrome.runtime.getURL('suspended.html');
  if (tab.url?.startsWith(base)) {
    const btn = document.getElementById('suspend-btn');
    btn.disabled = true;
    document.querySelector('.btn-sub').textContent = t('alreadySleeping');
  }

  refreshExclusionState(tab);
});

// ── Stats ────────────────────────────────────────────────────
const EST_MB_PER_TAB = 150;

function formatRam(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb + ' MB';
}

function formatSleep(minutes) {
  if (minutes < 1)  return '< 1 min';
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function refreshStats() {
  chrome.storage.local.get(['totalSleepMinutes'], data => {
    document.getElementById('impact-sleep').textContent = formatSleep(data.totalSleepMinutes || 0);
  });

  chrome.tabs.query({}, tabs => {
    const base = chrome.runtime.getURL('suspended.html');
    const n = tabs.filter(t => t.url?.startsWith(base)).length;
    const countEl = document.getElementById('sleeping-count');
    if (n === 0) countEl.textContent = t('noTabsSleeping');
    else countEl.innerHTML = `<span>${n}</span> ${n === 1 ? t('tabSleepingOne') : t('tabSleepingOther')}`;
    // Estimated RAM currently freed by the sleeping tabs (~150 MB/tab — real
    // per-tab memory isn't available to extensions).
    document.getElementById('impact-ram').textContent = formatRam(n * EST_MB_PER_TAB);
  });

  getRecoverableEntries().then(entries => {
    const hint = document.getElementById('recoverable-hint');
    hint.hidden = entries.length === 0;
    if (entries.length) {
      hint.textContent = plural(entries.length, 'recoverableHintOne', 'recoverableHintOther');
    }
  });
}
refreshStats();

// ── Floating zzz ────────────────────────────────────────────
function spawnZzz() {
  const layer  = document.getElementById('zzz-layer');
  const GLYPHS = [
    { ch: 'z', size: 13, delay: 0,    dur: 0.85, left: 36, dx: -8 },
    { ch: 'z', size: 17, delay: 0.12, dur: 0.95, left: 50, dx: 4  },
    { ch: 'Z', size: 22, delay: 0.26, dur: 1.1,  left: 62, dx: 10 },
  ];
  GLYPHS.forEach(g => {
    const el = document.createElement('span');
    el.className = 'z';
    el.textContent = g.ch;
    el.style.cssText = `
      font-size: ${g.size}px;
      bottom: 14px;
      left: ${g.left}%;
      --dur: ${g.dur}s;
      --delay: ${g.delay}s;
      --dx: ${g.dx}px;
    `;
    layer.appendChild(el);
    setTimeout(() => el.remove(), (g.dur + g.delay) * 1000 + 100);
  });
}

// ── Suspend action ───────────────────────────────────────────
document.getElementById('suspend-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const base = chrome.runtime.getURL('suspended.html');
  if (tab.url?.startsWith(base)) return;

  spawnZzz();

  setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'suspendTab', tabId: tab.id }, () => {
      refreshStats();
      showToast(t('toastSleeping'));
      setTimeout(() => window.close(), 900);
    });
  }, 380);
});

let hoverTimer;
document.getElementById('suspend-btn').addEventListener('mouseenter', () => {
  hoverTimer = setTimeout(spawnZzz, 250);
});
document.getElementById('suspend-btn').addEventListener('mouseleave', () => {
  clearTimeout(hoverTimer);
});

// ── Settings panel ───────────────────────────────────────────
const slider       = document.getElementById('slider');
const settingsBtn  = document.getElementById('settings-btn');
const backBtn      = document.getElementById('back-btn');

settingsBtn.addEventListener('click', () => {
  slider.classList.add('show-settings');
  loadSettings();
});

backBtn.addEventListener('click', () => {
  slider.classList.remove('show-settings');
});

// ── Exceptions panel ─────────────────────────────────────────
document.getElementById('exceptions-nav').addEventListener('click', () => {
  chrome.storage.local.get(['excludedUrls', 'excludedDomains'], data => {
    renderExceptionsList(data.excludedUrls || [], data.excludedDomains || []);
  });
  slider.classList.add('show-exceptions');
});

document.getElementById('exceptions-back-btn').addEventListener('click', () => {
  slider.classList.remove('show-exceptions');
});

// ── Sleeping tabs panel ──────────────────────────────────────
document.getElementById('sleeping-count').addEventListener('click', () => {
  slider.classList.add('show-sleeping');
  renderSleepingList();
});

document.getElementById('recoverable-hint').addEventListener('click', () => {
  slider.classList.add('show-sleeping');
  renderSleepingList();
});

document.getElementById('sleeping-back-btn').addEventListener('click', () => {
  slider.classList.remove('show-sleeping');
});

// Saved tabs that no longer have an open suspended page — closed windows or
// tabs an extension reload failed to recreate. Their page data still lives in
// suspendedData, so they can be reopened until the orphan purge drops them.
async function getRecoverableEntries() {
  const base = chrome.runtime.getURL('suspended.html');
  const openTids = new Set();
  const liveTabIds = new Set();
  for (const tab of await chrome.tabs.query({})) {
    liveTabIds.add(String(tab.id));
    if (!tab.url?.startsWith(base)) continue;
    const tid = new URL(tab.url).searchParams.get('tid');
    if (tid) openTids.add(tid);
  }
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  // A just-suspended tab still hosts its original id (tid === that id) while it
  // navigates to suspended.html, so a tabs query can't yet see it as an open
  // suspended page. Excluding live tab ids keeps it out of the recoverable list
  // during that brief window. After a reload the recreated tabs get new ids, so
  // genuinely-lost tids (closed windows, failed restores) still show up.
  return Object.entries(suspendedData)
    .filter(([tid, e]) => e?.url && !openTids.has(tid) && !liveTabIds.has(tid));
}

async function renderSleepingList() {
  const list  = document.getElementById('sleeping-list');
  const empty = document.getElementById('sleeping-empty');
  list.innerHTML = '';

  const base = chrome.runtime.getURL('suspended.html');
  const tabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith(base));
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  const suffix = t('sleepingSuffix');

  empty.hidden = tabs.length > 0;
  renderRecoverableList();

  tabs.forEach(tab => {
    const tid  = new URL(tab.url).searchParams.get('tid') ?? String(tab.id);
    const data = suspendedData[tid] || {};
    const orig = data.url;

    const row = document.createElement('div');
    row.className = 'sleep-item';

    if (data.favicon) {
      const fav = document.createElement('img');
      fav.className = 'sleep-fav';
      fav.src = data.favicon;
      fav.onerror = () => fav.remove();
      row.appendChild(fav);
    }

    const title = document.createElement('span');
    title.className = 'sleep-title';
    title.textContent = data.title || (tab.title || '').replace(suffix, '') || t('untitledTab');
    title.title = orig || '';
    row.appendChild(title);

    const wake = document.createElement('button');
    wake.className = 'sleep-wake';
    wake.textContent = t('wake');
    wake.disabled = !orig;
    wake.addEventListener('click', () => {
      chrome.tabs.update(tab.id, { url: orig });
      row.remove();
      if (!list.querySelector('.sleep-item')) empty.hidden = false;
      refreshStats();
    });
    row.appendChild(wake);

    list.appendChild(row);
  });
}

async function renderRecoverableList() {
  const section = document.getElementById('recoverable-section');
  const list    = document.getElementById('recoverable-list');
  list.innerHTML = '';

  const entries = await getRecoverableEntries();
  section.hidden = entries.length === 0;
  if (!entries.length) return;

  entries.forEach(([tid, data]) => {
    const row = document.createElement('div');
    row.className = 'sleep-item';

    if (data.favicon) {
      const fav = document.createElement('img');
      fav.className = 'sleep-fav';
      fav.src = data.favicon;
      fav.onerror = () => fav.remove();
      row.appendChild(fav);
    }

    const title = document.createElement('span');
    title.className = 'sleep-title';
    title.textContent = data.title || t('untitledTab');
    title.title = data.url;
    row.appendChild(title);

    const reopen = document.createElement('button');
    reopen.className = 'sleep-wake';
    reopen.textContent = t('reopen');
    reopen.addEventListener('click', async () => {
      chrome.tabs.create({ url: data.url, active: false });
      await forgetRecoverable([tid]);
      row.remove();
      renderRecoverableList();
      refreshStats();
    });
    row.appendChild(reopen);

    list.appendChild(row);
  });
}

// Reopening or forgetting a recoverable tab drops its saved data so it stops
// showing up — a reopened tab is a live tab again, a forgotten one is gone.
async function forgetRecoverable(tids) {
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  for (const tid of tids) delete suspendedData[tid];
  await chrome.storage.local.set({ suspendedData });
}

document.getElementById('recover-all').addEventListener('click', async () => {
  const entries = await getRecoverableEntries();
  if (!entries.length) return;
  entries.forEach(([, data]) => chrome.tabs.create({ url: data.url, active: false }));
  await forgetRecoverable(entries.map(([tid]) => tid));
  renderRecoverableList();
  refreshStats();
  showToast(plural(entries.length, 'toastReopenedOne', 'toastReopenedOther'));
});

document.getElementById('recover-forget').addEventListener('click', async () => {
  const entries = await getRecoverableEntries();
  if (!entries.length) return;
  await forgetRecoverable(entries.map(([tid]) => tid));
  renderRecoverableList();
  refreshStats();
  showToast(plural(entries.length, 'toastForgotOne', 'toastForgotOther'));
});

// Timer options
const TIMER_VALUES = [0, 5, 10, 20, 30, 60];

chrome.commands.getAll(commands => {
  const cmd = commands.find(c => c.name === 'suspend-tab');
  document.getElementById('shortcut-display').textContent = cmd?.shortcut || t('notSet');
});

document.getElementById('shortcut-configure').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

function loadSettings() {
  chrome.storage.local.get(
    ['autoSuspendMinutes', 'excludePinned', 'excludeAudible', 'excludeUnsavedForms', 'excludeActiveMedia', 'excludedUrls', 'excludedDomains'],
    data => {
      const minutes = data.autoSuspendMinutes ?? 20;
      document.querySelectorAll('.timer-opt').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.val) === minutes);
      });

      setToggle('toggle-pinned',  data.excludePinned       !== false);
      setToggle('toggle-audible', data.excludeAudible      !== false);
      setToggle('toggle-forms',   !!data.excludeUnsavedForms);
      setToggle('toggle-media',   data.excludeActiveMedia  !== false);

      renderExceptionsList(data.excludedUrls || [], data.excludedDomains || []);
    }
  );
}

function renderExceptionsList(urls, domains) {
  const list  = document.getElementById('exceptions-list');
  const empty = document.getElementById('exceptions-empty');
  list.innerHTML = '';

  const all = [
    ...urls.map(v => ({ type: 'url', value: v })),
    ...domains.map(v => ({ type: 'domain', value: v })),
  ];

  empty.hidden = all.length > 0;
  document.getElementById('exc-remove-all').disabled = all.length === 0;

  const countEl = document.getElementById('exceptions-count');
  countEl.textContent = all.length;
  countEl.hidden = all.length === 0;

  all.forEach(({ type, value }) => {
    const label = document.createElement('label');
    label.className = 'exc-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'exc-check';
    cb.dataset.type  = type;
    cb.dataset.value = value;
    cb.addEventListener('change', syncExcRemoveSelected);

    label.addEventListener('click', e => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
      e.preventDefault();
    });

    const badge = document.createElement('span');
    badge.className = `exc-badge exc-badge-${type}`;
    badge.textContent = type === 'url' ? 'URL' : 'Domain';

    const val = document.createElement('span');
    val.className = 'exc-value';
    val.title = value;
    val.textContent = value;

    label.append(cb, badge, val);
    list.appendChild(label);
  });
}

function syncExcRemoveSelected() {
  const anyChecked = document.querySelector('.exc-check:checked') !== null;
  document.getElementById('exc-remove-selected').disabled = !anyChecked;

  document.querySelectorAll('.exc-item').forEach(item => {
    item.classList.toggle('selected', item.querySelector('.exc-check').checked);
  });
}

document.getElementById('exc-remove-selected').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('.exc-check:checked')];
  const rmUrls    = checked.filter(c => c.dataset.type === 'url').map(c => c.dataset.value);
  const rmDomains = checked.filter(c => c.dataset.type === 'domain').map(c => c.dataset.value);

  const { excludedUrls = [], excludedDomains = [] } =
    await chrome.storage.local.get(['excludedUrls', 'excludedDomains']);

  await chrome.storage.local.set({
    excludedUrls:    excludedUrls.filter(u => !rmUrls.includes(u)),
    excludedDomains: excludedDomains.filter(d => !rmDomains.includes(d)),
  });

  loadSettings();
  if (currentTab) refreshExclusionState(currentTab);
  showToast(plural(checked.length, 'toastRemovedOne', 'toastRemovedOther'));
});

document.getElementById('exc-remove-all').addEventListener('click', async () => {
  await chrome.storage.local.set({ excludedUrls: [], excludedDomains: [] });
  loadSettings();
  if (currentTab) refreshExclusionState(currentTab);
  showToast(t('toastAllExceptionsRemoved'));
});

document.getElementById('timer-grid').addEventListener('click', e => {
  const btn = e.target.closest('.timer-opt');
  if (!btn) return;
  const val = Number(btn.dataset.val);
  document.querySelectorAll('.timer-opt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  chrome.storage.local.set({ autoSuspendMinutes: val });
});

function setToggle(id, on) {
  document.getElementById(id).classList.toggle('on', on);
}

const TOGGLE_KEYS = {
  'toggle-pinned':  'excludePinned',
  'toggle-audible': 'excludeAudible',
  'toggle-forms':   'excludeUnsavedForms',
  'toggle-media':   'excludeActiveMedia',
};

Object.keys(TOGGLE_KEYS).forEach(id => {
  document.getElementById(id).addEventListener('click', function () {
    const on = !this.classList.contains('on');
    this.classList.toggle('on', on);
    chrome.storage.local.set({ [TOGGLE_KEYS[id]]: on });
  });
});

// ── Quick actions ────────────────────────────────────────────
async function refreshExclusionState(tab) {
  if (!tab?.url || tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) return;

  const { excludedUrls = [], excludedDomains = [] } =
    await chrome.storage.local.get(['excludedUrls', 'excludedDomains']);

  const urlActive = excludedUrls.includes(tab.url);
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch {}
  const domainActive = domain && excludedDomains.includes(domain);

  document.getElementById('qa-never-url').classList.toggle('active', urlActive);
  document.getElementById('qa-never-domain').classList.toggle('active', domainActive);
}

document.getElementById('qa-never-url').addEventListener('click', async () => {
  if (!currentTab?.url) return;
  const url = currentTab.url;
  const { excludedUrls = [] } = await chrome.storage.local.get('excludedUrls');
  const idx = excludedUrls.indexOf(url);
  if (idx === -1) {
    excludedUrls.push(url);
    await chrome.storage.local.set({ excludedUrls });
    document.getElementById('qa-never-url').classList.add('active');
    showToast(t('toastUrlAdded'));
  } else {
    excludedUrls.splice(idx, 1);
    await chrome.storage.local.set({ excludedUrls });
    document.getElementById('qa-never-url').classList.remove('active');
    showToast(t('toastUrlRemoved'));
  }
});

document.getElementById('qa-never-domain').addEventListener('click', async () => {
  if (!currentTab?.url) return;
  let domain = '';
  try { domain = new URL(currentTab.url).hostname; } catch {}
  if (!domain) return;

  const { excludedDomains = [] } = await chrome.storage.local.get('excludedDomains');
  const idx = excludedDomains.indexOf(domain);
  if (idx === -1) {
    excludedDomains.push(domain);
    await chrome.storage.local.set({ excludedDomains });
    document.getElementById('qa-never-domain').classList.add('active');
    showToast(t('toastDomainAdded', domain));
  } else {
    excludedDomains.splice(idx, 1);
    await chrome.storage.local.set({ excludedDomains });
    document.getElementById('qa-never-domain').classList.remove('active');
    showToast(t('toastDomainRemoved', domain));
  }
});

document.getElementById('qa-suspend-all').addEventListener('click', async () => {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = await chrome.tabs.query({});
  const base = chrome.runtime.getURL('suspended.html');

  const {
    excludePinned = true,
    excludeAudible = true,
    excludedUrls = [],
    excludedDomains = [],
  } = await chrome.storage.local.get(
    ['excludePinned', 'excludeAudible', 'excludedUrls', 'excludedDomains']
  );

  const targets = tabs.filter(t => {
    if (t.id === active?.id || !t.url) return false;
    if (
      t.url.startsWith(base) ||
      t.url.startsWith('chrome://') ||
      t.url.startsWith('chrome-extension://') ||
      t.url.startsWith('about:')
    ) return false;
    if (excludePinned  && t.pinned)  return false;
    if (excludeAudible && t.audible) return false;
    if (excludedUrls.includes(t.url)) return false;
    try {
      if (excludedDomains.includes(new URL(t.url).hostname)) return false;
    } catch {}
    return true;
  });

  showToast(plural(targets.length, 'toastSuspendingOne', 'toastSuspendingOther'));
  await chrome.runtime.sendMessage({ action: 'suspendAllTabs', tabIds: targets.map(t => t.id) });
  setTimeout(() => { refreshStats(); window.close(); }, 900);
});

document.getElementById('qa-unsuspend-all').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({});
  const base = chrome.runtime.getURL('suspended.html');
  const suspended = tabs.filter(t => t.url?.startsWith(base));
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  for (const t of suspended) {
    const tid = new URL(t.url).searchParams.get('tid') ?? t.id;
    const orig = suspendedData[tid]?.url;
    if (orig) chrome.tabs.update(t.id, { url: orig });
  }
  showToast(plural(suspended.length, 'toastWakingOne', 'toastWakingOther'));
  setTimeout(() => { refreshStats(); window.close(); }, 900);
});

// ── Toast ────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
