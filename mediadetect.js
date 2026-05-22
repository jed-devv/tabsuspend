// Runs in the page's MAIN world at document_start. Patches getUserMedia /
// getDisplayMedia so we can tell when a tab is actively using the camera or
// mic (a call, recording, screen share). While any audio/video input track is
// live, we set data-tabnap-call on <html>; the isolated content script reads
// that flag and the background skips auto-suspending such tabs.
(() => {
  const md = navigator.mediaDevices;
  if (!md) return;

  const live = new Set();

  const mark = () => {
    if (live.size > 0) document.documentElement.dataset.tabnapCall = '1';
    else delete document.documentElement.dataset.tabnapCall;
  };

  const trackStream = stream => {
    stream?.getTracks?.().forEach(t => {
      if (t.kind !== 'audio' && t.kind !== 'video') return;
      live.add(t);
      mark();
      const drop = () => { live.delete(t); mark(); };
      t.addEventListener('ended', drop);
      const stop = t.stop.bind(t);
      t.stop = () => { drop(); stop(); };
    });
    return stream;
  };

  const wrap = orig => async function (...args) {
    return trackStream(await orig.apply(this, args));
  };

  if (md.getUserMedia)    md.getUserMedia    = wrap(md.getUserMedia.bind(md));
  if (md.getDisplayMedia) md.getDisplayMedia = wrap(md.getDisplayMedia.bind(md));
})();
