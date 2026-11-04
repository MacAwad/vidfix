'use strict';
const VF = globalThis.VF;
const $ = (id) => document.getElementById(id);
let S = VF.cloneDefaults();
let savedTimer = 0;

const SELECTS = { barMode: String, barPosition: String, autoHideMs: Number, maxBoost: Number, seekStep: Number, speedStep: Number };
const CHECKS = ['rememberSpeed', 'lockSpeed', 'rememberVolume', 'startUnmuted', 'blockAutoplay', 'shortcutsEnabled', 'enabled'];

async function save() {
  await chrome.storage.sync.set({ settings: S });
  $('saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
}

function renderKeys() {
  const box = $('keys');
  box.textContent = '';
  for (const [id, label] of VF.KEY_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'key';
    const l = document.createElement('span');
    l.textContent = label;
    const b = document.createElement('button');
    b.textContent = VF.keyLabel(S.keys[id]);
    b.addEventListener('click', () => {
      b.textContent = 'Press a key';
      b.classList.add('wait');
      const onKey = (e) => {
        e.preventDefault();
        window.removeEventListener('keydown', onKey, true);
        b.classList.remove('wait');
        if (e.code === 'Escape') { b.textContent = VF.keyLabel(S.keys[id]); return; }
        const code = e.code === 'Backspace' || e.code === 'Delete' ? '' : e.code;
        if (code) for (const k in S.keys) if (S.keys[k] === code) S.keys[k] = ''; // no duplicates
        S.keys[id] = code;
        renderKeys();
        save();
      };
      window.addEventListener('keydown', onKey, true);
    });
    row.append(l, b);
    box.append(row);
  }
}

function renderSites() {
  const box = $('sites');
  box.textContent = '';
  if (!S.disabledSites.length) {
    const p = document.createElement('span');
    p.className = 'hint';
    p.textContent = 'None';
    box.append(p);
    return;
  }
  for (const h of S.disabledSites) {
    const s = document.createElement('span');
    s.className = 'site';
    s.textContent = h;
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Turn VidFix back on for ' + h;
    x.addEventListener('click', () => { S.disabledSites = S.disabledSites.filter((y) => y !== h); renderSites(); save(); });
    s.append(x);
    box.append(s);
  }
}

async function init() {
  const { settings } = await chrome.storage.sync.get('settings');
  S = VF.mergeSettings(settings);
  for (const [id, cast] of Object.entries(SELECTS)) {
    const sel = $(id);
    sel.value = String(S[id]);
    if (sel.value !== String(S[id])) { const o = document.createElement('option'); o.value = String(S[id]); o.textContent = String(S[id]); sel.append(o); sel.value = String(S[id]); }
    sel.addEventListener('change', () => { S[id] = cast(sel.value); save(); });
  }
  for (const id of CHECKS) {
    const c = $(id);
    c.checked = !!S[id];
    c.addEventListener('change', () => { S[id] = c.checked; save(); });
  }
  $('resetKeys').addEventListener('click', () => { S.keys = VF.cloneDefaults().keys; renderKeys(); save(); });
  renderKeys();
  renderSites();
  if (location.hash === '#welcome') $('welcome').hidden = false;
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'sync' && ch.settings) { S = VF.mergeSettings(ch.settings.newValue); renderSites(); }
});
init();
