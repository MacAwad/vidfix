/* VidFix - background worker: hands direct files to Chrome's download manager and takes tab
   snapshots for screenshots of protected-from-canvas videos. No network calls of its own, no tracking. */
'use strict';

const BLOCKED = /(^|\.)(googlevideo\.com|youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

function cleanName(name) {
  return String(name || 'video.mp4').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video.mp4';
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'vf:download') {
    let host = '';
    try { host = new URL(msg.url).hostname; } catch (e) { reply({ ok: false, error: 'Bad link' }); return false; }
    if (BLOCKED.test(host)) { reply({ ok: false, error: 'Not allowed' }); return false; }
    chrome.downloads.download({ url: msg.url, filename: cleanName(msg.filename), conflictAction: 'uniquify' })
      .then((id) => reply({ ok: true, id }))
      .catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'vf:capture') {
    const winId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(winId, { format: 'png' })
      .then((dataUrl) => reply({ dataUrl }))
      .catch((e) => reply({ error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'vf:options') {
    chrome.runtime.openOptionsPage();
    reply({ ok: true });
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#welcome') });
});
