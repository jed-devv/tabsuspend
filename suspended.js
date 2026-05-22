// ── Starfield ──────────────────────────────────────────────
const canvas = document.getElementById('stars');
const ctx    = canvas.getContext('2d');

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', resize);

const STARS = Array.from({ length: 140 }, () => ({
  x:    Math.random(),
  y:    Math.random(),
  r:    Math.random() * 1.3 + 0.2,
  spd:  Math.random() * 0.005 + 0.0015,
  ph:   Math.random() * Math.PI * 2,
  warm: Math.random() > 0.55,
}));

function paint(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  STARS.forEach(s => {
    const alpha = 0.1 + 0.6 * Math.abs(Math.sin(t * s.spd + s.ph));
    ctx.beginPath();
    ctx.arc(s.x * canvas.width, s.y * canvas.height, s.r, 0, Math.PI * 2);
    ctx.fillStyle = s.warm
      ? `rgba(240,201,74,${alpha})`
      : `rgba(184,168,255,${alpha})`;
    ctx.fill();
  });
  requestAnimationFrame(paint);
}
requestAnimationFrame(paint);

// ── Load tab data from session storage ────────────────────
const tid = new URLSearchParams(location.search).get('tid');

// Tell the background which stable tid this live tab hosts, so it can clean up
// suspendedData by the stable key when the tab wakes up (tab ids change across
// browser restarts; tid does not).
if (tid) chrome.runtime.sendMessage({ action: 'register', tid });

let origUrl = '';

chrome.tabs.getCurrent(async tab => {
  // tid from URL is the stable key (survives tab.id changes on extension reload).
  // Fall back to current tab.id for legacy entries.
  const { suspendedData = {} } = await chrome.storage.local.get('suspendedData');
  const data = (tid && suspendedData[tid]) || (tab?.id && suspendedData[tab.id]) || {};

  origUrl = data.url || '';

  const title       = data.title       || 'Untitled tab';
  const favicon     = data.favicon     || '';
  const grayFavicon = data.grayFavicon || '';

  document.getElementById('page-title').textContent = title;
  document.title = title + ' – sleeping';

  const urlEl = document.getElementById('page-url');
  try {
    urlEl.textContent = new URL(origUrl).hostname;
  } catch {
    urlEl.textContent = origUrl.slice(0, 60) || '';
  }

  const favEl = document.getElementById('page-favicon');
  if (favicon) {
    favEl.src = favicon;
    favEl.style.display = 'inline-block';
    favEl.style.filter = 'grayscale(1) opacity(0.5)';
    favEl.onerror = () => favEl.style.display = 'none';
  }

  const tabIcon = grayFavicon || favicon;
  if (tabIcon) {
    const link = document.createElement('link');
    link.rel  = 'icon';
    link.href = tabIcon;
    document.head.appendChild(link);
  }
});

// ── Suspended-at timestamp ────────────────────────────────
const now = new Date();
document.getElementById('suspended-at').textContent =
  now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ── Wake on click anywhere ─────────────────────────────────
document.addEventListener('click', () => {
  if (!origUrl) return;
  chrome.tabs.getCurrent(tab => {
    chrome.tabs.update(tab.id, { url: origUrl });
  });
});
