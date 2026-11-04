'use strict';
const VF = globalThis.VF;
const $ = (id) => document.getElementById(id);
let tab = null, host = '', settings = VF.cloneDefaults();
let videos = [], selected = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function send(msg) {
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { return null; }
}
const metaOf = (v) => [isFinite(v.duration) ? VF.fmtTime(v.duration) : 'Live', v.paused ? 'paused' : 'playing', v.muted ? 'muted' : '']
  .filter(Boolean).join(' · ');
function thumbEl(v, cls) {
  const t = el('div', cls || 'thumb');
  if (v.thumb) t.style.backgroundImage = `url("${v.thumb}")`;
  return t;
}

async function init() {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) tab = await chrome.tabs.get(forced);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { settings: saved } = await chrome.storage.sync.get('settings');
  settings = VF.mergeSettings(saved);
  try { host = VF.hostKey(new URL(tab.url).hostname); } catch (e) { host = ''; }
  const toggle = $('siteToggle');
  if (!host || !/^(https?|file):/.test(tab.url)) {
    $('site').textContent = 'Not available on this page';
    toggle.disabled = true;
    empty('Nothing to control here', 'Open a page with a video.');
    return;
  }
  const on = settings.enabled && !settings.disabledSites.includes(host);
  toggle.checked = on;
  $('site').textContent = (on ? 'On for ' : 'Off for ') + host;
  toggle.addEventListener('change', async () => {
    const list = settings.disabledSites.filter((h) => h !== host);
    if (!toggle.checked) list.push(host); else settings.enabled = true;
    settings.disabledSites = list;
    await chrome.storage.sync.set({ settings });
    $('site').textContent = (toggle.checked ? 'On for ' : 'Off for ') + host;
    load();
  });
  load();
}

function empty(title, text) {
  const m = $('main');
  m.textContent = '';
  const d = el('div', 'empty');
  d.append(el('b', '', title), document.createTextNode(text));
  m.append(d);
}

async function load() {
  const res = await send({ type: 'vf:list' });
  if (!res) {
    empty('No video found', 'Play a video, then click VidFix again. Just installed VidFix? Refresh this page first.');
    return;
  }
  if (!res.enabled) { empty('VidFix is off for this site', 'Turn it on with the switch above.'); return; }
  videos = res.videos || [];
  if (!videos.length) { empty('No video found', 'Play a video, then click VidFix again.'); return; }
  if (!selected || !videos.some((v) => v.id === selected)) selected = videos[0].id;
  render();
}

function render() {
  const m = $('main');
  m.textContent = '';
  const v = videos.find((x) => x.id === selected);
  const noDl = !!VF.siteRule(host).noDownload;

  const now = el('div', 'now');
  const info = el('div');
  info.append(el('div', 't', v.main || v.id === videos[0].id ? 'Video on screen' : 'Selected video'), el('div', 'm', metaOf(v)));
  now.append(thumbEl(v), info);
  m.append(now);

  const sl = el('div', 'label');
  sl.append(el('span', '', 'Speed'), el('span', '', (Math.round(v.rate * 100) / 100) + 'x'));
  m.append(sl);
  const seg = el('div', 'seg');
  for (const r of [0.5, 1, 1.25, 1.5, 2, 3]) {
    const b = el('button', Math.abs(v.rate - r) < 0.01 ? 'on' : '', r + 'x');
    b.addEventListener('click', async () => {
      await send({ type: 'vf:act', id: v.id, action: 'speed', value: r });
      v.rate = r;
      render();
    });
    seg.append(b);
  }
  m.append(seg);

  const vl = el('div', 'label');
  const vval = el('span', '', v.muted ? 'muted' : v.volume + '%');
  vl.append(el('span', '', 'Volume (over 100% = boost)'), vval);
  m.append(vl);
  const range = el('input');
  range.type = 'range'; range.min = 0; range.max = settings.maxBoost; range.step = 5; range.value = v.volume;
  range.addEventListener('input', async () => {
    const r = await send({ type: 'vf:act', id: v.id, action: 'volume', value: Number(range.value) });
    v.volume = r ? r.volume : Number(range.value);
    v.muted = false;
    vval.textContent = v.volume + '%';
  });
  m.append(range);

  const actions = el('div', 'actions');
  const save = el('button', 'btn primary', 'Save video');
  save.disabled = noDl || v.protected;
  save.addEventListener('click', async () => { await send({ type: 'vf:act', id: v.id, action: 'download' }); window.close(); });
  const show = el('button', 'btn', 'Show controls');
  show.title = 'Show the VidFix control bar on this video';
  show.addEventListener('click', async () => { await send({ type: 'vf:act', id: v.id, action: 'show' }); window.close(); });
  actions.append(save, show);
  m.append(actions);
  if (noDl) m.append(el('div', 'note', 'Saving is turned off on YouTube (Chrome Web Store rule). Speed and boost still work.'));
  else if (v.protected) m.append(el('div', 'note', 'This video is DRM-protected, so it cannot be saved.'));

  const others = videos.filter((x) => x.id !== v.id);
  if (others.length) {
    const d = el('details', 'more');
    d.append(el('summary', '', `${others.length} more video${others.length > 1 ? 's' : ''} on this page`));
    for (const o of others.slice(0, 8)) {
      const row = el('div', 'row');
      const pick = el('button', '', 'Select');
      pick.addEventListener('click', () => { selected = o.id; send({ type: 'vf:act', id: o.id, action: 'show' }); render(); });
      row.append(thumbEl(o), el('div', 'm', metaOf(o)), pick);
      d.append(row);
    }
    m.append(d);
  }
}

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
init();
