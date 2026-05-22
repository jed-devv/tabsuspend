// Reports user activity to the background so the idle timer can be reset.
// Throttled to at most one message every 10 seconds.
let lastActivity = 0;
let contextValid = true;

function isContextValid() {
  if (!contextValid) return false;
  try {
    return !!chrome.runtime?.id;
  } catch {
    contextValid = false;
    return false;
  }
}

const EVENTS = ['mousemove', 'keydown', 'scroll', 'click'];
const onActivity = () => {
  const now = Date.now();
  if (now - lastActivity < 10_000) return;
  lastActivity = now;
  if (!isContextValid()) {
    EVENTS.forEach(evt => document.removeEventListener(evt, onActivity));
    return;
  }
  try {
    chrome.runtime.sendMessage({ action: 'activity' }).catch(() => {});
  } catch {
    contextValid = false;
  }
};

EVENTS.forEach(evt => document.addEventListener(evt, onActivity, { passive: true }));

// Responds to background checks for unsaved form data.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'hasActiveMediaStream') {
    sendResponse(document.documentElement.dataset.tabnapCall === '1');
    return;
  }
  if (msg.action !== 'hasUnsavedInputs') return;

  const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="search"], input[type="tel"], input[type="url"], input[type="password"], input:not([type]), textarea');
  for (const el of inputs) {
    if (el.value.trim()) { sendResponse(true); return; }
  }

  const editables = document.querySelectorAll('[contenteditable="true"], [contenteditable=""]');
  for (const el of editables) {
    if (el.textContent.trim()) { sendResponse(true); return; }
  }

  sendResponse(false);
});
