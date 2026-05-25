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

const INPUT_SELECTOR = 'input[type="text"], input[type="email"], input[type="search"], input[type="tel"], input[type="url"], input[type="password"], input:not([type]), textarea';
const EDITABLE_SELECTOR = '[contenteditable="true"], [contenteditable=""]';

// Walk a root (document or shadow root), recursing into iframes and shadow roots.
function rootHasUnsavedInputs(root) {
  for (const el of root.querySelectorAll(INPUT_SELECTOR)) {
    if (el.value.trim()) return true;
  }
  for (const el of root.querySelectorAll(EDITABLE_SELECTOR)) {
    if (el.textContent.trim()) return true;
  }
  // Shadow roots
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot && rootHasUnsavedInputs(el.shadowRoot)) return true;
  }
  // Same-origin iframes
  for (const frame of root.querySelectorAll('iframe')) {
    try {
      if (frame.contentDocument && rootHasUnsavedInputs(frame.contentDocument)) return true;
    } catch { /* cross-origin — skip */ }
  }
  return false;
}

// Responds to background checks for unsaved form data.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'hasActiveMediaStream') {
    sendResponse(document.documentElement.dataset.tabnapCall === '1');
    return;
  }
  if (msg.action !== 'hasUnsavedInputs') return;

  sendResponse(rootHasUnsavedInputs(document));
});
