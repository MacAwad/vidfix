/* VidFix - background worker: hands direct files to Chrome's download manager and takes tab
   snapshots for screenshots of protected-from-canvas videos. No network calls of its own, no tracking. */
'use strict';

const BLOCKED = /(^|\.)(googlevideo\.com|youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

// ---- Stream list per tab ----
// Notes the video stream addresses a tab requests (including requests made by Web Workers, which the
// page itself cannot see). Read-only observation, kept in session memory, cleared when the tab
// navigates or closes. Never sent anywhere.
const SEGMENT = /(^|[\/_-])(seg|segment|chunk|frag|fragment|init)[-_]?\d*\.(mp4|m4s|m4v|m4a)$|\.m4s$|\.ts$|\.aac$/i;
const tabs = new Map();
let saveTimers = {};

function classify(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (BLOCKED.test(u.hostname)) return null;
  const path = u.pathname.toLowerCase();
  let kind = null;
  if (path.endsWith('.m3u8')) kind = 'hls';
  else if (path.endsWith('.mpd')) kind = 'dash';
  else if (u.searchParams.has('bytestart') && u.searchParams.has('byteend')) kind = 'ranged';
  else if (/\.(mp4|m4v|webm|mov|mkv)$/.test(path) && !SEGMENT.test(path)) kind = 'file';
  if (!kind) return null;
  if (kind === 'ranged') { u.searchParams.delete('bytestart'); u.searchParams.delete('byteend'); }
  return { url: u.toString(), kind };
}

async function tabMap(tabId) {
  let m = tabs.get(tabId);
  if (m) return m;
  m = new Map();
  try {
    const got = await chrome.storage.session.get('net:' + tabId);
    for (const e of got['net:' + tabId] || []) m.set(e.url, e);
  } catch (e) { /* ignore */ }
  tabs.set(tabId, m);
  return m;
}
function persist(tabId) {
  clearTimeout(saveTimers[tabId]);
  saveTimers[tabId] = setTimeout(() => {
    const m = tabs.get(tabId);
    if (m) chrome.storage.session.set({ ['net:' + tabId]: Array.from(m.values()).slice(-200) }).catch(() => {});
  }, 500);
}
function clearTab(tabId) {
  tabs.delete(tabId);
  chrome.storage.session.remove('net:' + tabId).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  if (d.type === 'main_frame') { clearTab(d.tabId); return; }
  const c = classify(d.url);
  if (!c) return;
  tabMap(d.tabId).then((m) => {
    const e = m.get(c.url);
    if (e) e.last = Date.now();
    else {
      m.set(c.url, { url: c.url, kind: c.kind, last: Date.now() });
      if (m.size > 300) m.delete(m.keys().next().value);
    }
    persist(d.tabId);
  });
}, { urls: ['<all_urls>'], types: ['main_frame', 'xmlhttprequest', 'media', 'other'] });

chrome.tabs.onRemoved.addListener(clearTab);

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

  if (msg.type === 'vf:net') {
    if (!sender.tab) { reply({ entries: [] }); return false; }
    tabMap(sender.tab.id).then((m) => reply({ entries: Array.from(m.values()) }));
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
