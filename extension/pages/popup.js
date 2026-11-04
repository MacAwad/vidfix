'use strict';
const VF = globalThis.VF;
const $ = (id) => document.getElementById(id);
let tab = null, host = '', settings = VF.cloneDefaults();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function send(msg) {
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { return null; }
}

async function init() {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) tab = await chrome.tabs.get(forced);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { settings: saved } = await chrome.storage.sync.get('settings');
  settings = VF.mergeSettings(saved);
  try { host = VF.hostKey(new URL(tab.url).hostname); } catch (e) { host = ''; }
  const toggle = $('siteToggle');
  if (!host || !/^https?:|^file:/.test(tab.url)) {
    $('site').textContent = 'VidFix does not run on this page.';
    toggle.disabled = true;
    $('list').append(el('div', 'empty', 'Open a page with a video to use VidFix.'));
    return;
  }
  const on = settings.enabled && !settings.disabledSites.includes(host);
  toggle.checked = on;
  $('site').textContent = on ? 'On for ' + host : 'Off for ' + host;
  toggle.addEventListener('change', async () => {
    const list = settings.disabledSites.filter((h) => h !== host);
    if (!toggle.checked) list.push(host);
    settings.disabledSites = list;
    if (toggle.checked) settings.enabled = true;
    await chrome.storage.sync.set({ settings });
    $('site').textContent = (toggle.checked ? 'On for ' : 'Off for ') + host;
    render();
  });
  render();
}

async function render() {
  const list = $('list');
  list.textContent = '';
  const res = await send({ type: 'vf:list' });
  if (!res || !res.videos || !res.videos.length) {
    list.append(el('div', 'empty', 'No videos found on this page yet. Start playing one, then open VidFix again.'));
    return;
  }
  const vids = res.videos.slice().sort((a, b) => (b.visible - a.visible) || (a.paused - b.paused));
  vids.slice(0, 6).forEach((v, i) => list.append(card(v, i)));
  if (!res.enabled) list.prepend(el('div', 'note', 'VidFix is off for this site. Turn it on with the switch above.'));
}

function card(v, i) {
  const c = el('div', 'card');
  const h = el('h3', '', 'Video ' + (i + 1));
  const meta = [v.w && v.h ? `${v.w}x${v.h}` : '', isFinite(v.duration) ? VF.fmtTime(v.duration) : 'live', v.paused ? 'paused' : 'playing']
    .filter(Boolean).join(' · ');
  h.append(el('span', '', meta));
  c.append(h);

  const sp = el('div', 'row');
  sp.append(el('label', '', 'Speed'));
  for (const r of [0.75, 1, 1.25, 1.5, 2, 3]) {
    const b = el('button', 'chip' + (Math.abs(v.rate - r) < 0.01 ? ' on' : ''), r + 'x');
    b.addEventListener('click', async () => {
      await send({ type: 'vf:act', id: v.id, action: 'speed', value: r });
      sp.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
    sp.append(b);
  }
  c.append(sp);

  const vr = el('div', 'row');
  vr.append(el('label', '', 'Volume'));
  const range = el('input');
  range.type = 'range'; range.min = 0; range.max = settings.maxBoost; range.value = v.volume;
  const val = el('span', 'val', v.muted ? 'muted' : v.volume + '%');
  range.addEventListener('input', async () => {
    const r = await send({ type: 'vf:act', id: v.id, action: 'volume', value: Number(range.value) });
    val.textContent = (r ? r.volume : range.value) + '%';
  });
  vr.append(range, val);
  c.append(vr);

  const btns = el('div', 'btns');
  const show = el('button', 'btn', 'Show controls');
  show.addEventListener('click', async () => { await send({ type: 'vf:act', id: v.id, action: 'show' }); window.close(); });
  const dl = el('button', 'btn primary', 'Save video');
  dl.addEventListener('click', async () => { await send({ type: 'vf:act', id: v.id, action: 'download' }); window.close(); });
  btns.append(show, dl);
  c.append(btns);
  if (v.protected) { dl.disabled = true; c.append(el('div', 'note', 'DRM-protected video: controls work, saving does not.')); }
  if (VF.siteRule(host).noDownload) {
    dl.disabled = true;
    show.remove();
    c.append(el('div', 'note', 'Saving from YouTube is not allowed by Chrome Web Store rules. Speed and volume boost still work.'));
  }
  return c;
}

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
init();
