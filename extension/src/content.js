/* VidFix - control bar, shortcuts, speed / volume memory, boost, record, screenshot and download for every <video>. */
(function () {
  'use strict';
  if (window.__vfMain) return;
  window.__vfMain = true;

  const VF = globalThis.VF;
  const HOST = VF.hostKey(location.hostname);
  const RULE = VF.siteRule(location.hostname);
  const IS_TOP = window === window.top;

  let S = VF.cloneDefaults();
  let SITE = {};            // remembered per-site values: { speed, volume }
  let enabled = false;
  let started = false;

  const lightVideos = document.getElementsByTagName('video'); // live list, cheap
  const shadowVideos = new Set();
  const tracked = new WeakSet();
  const ids = new WeakMap();
  const byId = new Map();
  let nextId = 1;
  const st = new WeakMap(); // per-video state

  const now = () => performance.now();
  const vstate = (v) => {
    let s = st.get(v);
    if (!s) {
      s = { rate: null, ourRateAt: 0, fights: 0, fightStart: 0, gaveUp: false, prefsApplied: false,
        unmuted: false, allowPlayUntil: 0, a: null, b: null, hadControls: null };
      st.set(v, s);
    }
    return s;
  };
  const idOf = (v) => {
    let id = ids.get(v);
    if (!id) { id = nextId++; ids.set(v, id); byId.set(id, new WeakRef(v)); }
    return id;
  };

  // ---------- settings ----------
  async function loadSettings() {
    try {
      const [{ settings }, local] = await Promise.all([
        chrome.storage.sync.get('settings'),
        chrome.storage.local.get('site:' + HOST)
      ]);
      S = VF.mergeSettings(settings);
      SITE = local['site:' + HOST] || {};
    } catch (e) { /* extension reloaded or storage unavailable */ }
  }
  const barMode = () => (RULE.barMode && S.barMode !== 'off' ? RULE.barMode : S.barMode);
  const shortcutsOn = () => S.shortcutsEnabled && RULE.shortcuts !== false;
  const isEnabledHere = () => S.enabled && !S.disabledSites.includes(HOST);

  let saveTimer = 0;
  function saveSite(patch) {
    Object.assign(SITE, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { chrome.storage.local.set({ ['site:' + HOST]: SITE }); } catch (e) { /* ignore */ }
    }, 400);
  }

  // ---------- video tracking ----------
  function track(v) {
    if (!v || v.tagName !== 'VIDEO' || tracked.has(v)) return;
    tracked.add(v);
    idOf(v);
    v.addEventListener('ratechange', onRateChange);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('play', onPlay);
    v.addEventListener('timeupdate', onTimeUpdate);
    if (v.readyState >= 1) onMeta({ target: v });
  }

  function allVideos(deep) {
    const list = Array.from(lightVideos);
    for (const v of shadowVideos) if (v.isConnected) list.push(v); else shadowVideos.delete(v);
    if (deep) {
      const walk = (root) => {
        const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let n = tw.currentNode;
        while (n) {
          if (n.shadowRoot) {
            for (const v of n.shadowRoot.querySelectorAll('video')) if (!list.includes(v)) { list.push(v); shadowVideos.add(v); }
            walk(n.shadowRoot);
          }
          n = tw.nextNode();
        }
      };
      try { walk(document.documentElement); } catch (e) { /* ignore */ }
    }
    list.forEach(track);
    return list;
  }

  function onMeta(e) {
    const v = e.target;
    applyPrefs(v);
  }

  function applyPrefs(v) {
    if (!enabled) return;
    const s = vstate(v);
    if (S.rememberSpeed && SITE.speed && Math.abs(SITE.speed - 1) > 0.001) {
      if (s.rate === null) s.rate = SITE.speed;
    }
    if (s.rate !== null && Math.abs(v.playbackRate - s.rate) > 0.001) setRateRaw(v, s.rate);
    if (!s.prefsApplied) {
      s.prefsApplied = true;
      if (S.rememberVolume && typeof SITE.volume === 'number') {
        try { v.volume = Math.min(1, SITE.volume / 100); } catch (err) { /* ignore */ }
        if (SITE.volume > 100) pendingBoost.add(v);
      }
    }
  }

  function onPlay(e) {
    const v = e.target;
    const s = vstate(v);
    if (S.blockAutoplay && enabled) {
      const ua = navigator.userActivation;
      const userCaused = (ua && ua.isActive) || now() < s.allowPlayUntil || now() - lastGesture < 1500;
      if (!userCaused) { v.pause(); return; }
    }
    if (S.startUnmuted && enabled && v.muted && !s.unmuted && navigator.userActivation && navigator.userActivation.hasBeenActive) {
      s.unmuted = true;
      v.muted = false;
      if (S.rememberVolume && typeof SITE.volume === 'number') v.volume = Math.min(1, SITE.volume / 100);
    }
    applyPrefs(v);
    if (pendingBoost.has(v) && audioReady) applyBoost(v, SITE.volume);
  }

  function onRateChange(e) {
    const v = e.target;
    const s = vstate(v);
    if (!enabled || !S.lockSpeed || s.rate === null || s.gaveUp) return;
    if (Math.abs(v.playbackRate - s.rate) < 0.001) return; // our own change
    // The site changed the speed on its own (many players reset to 1x on pause / seek). Put it back,
    // but stop fighting if the site keeps insisting.
    const t = now();
    if (t - s.fightStart > 3000) { s.fightStart = t; s.fights = 0; }
    if (++s.fights > 6) { s.gaveUp = true; return; }
    setRateRaw(v, s.rate);
  }

  function onTimeUpdate(e) {
    const v = e.target;
    const s = st.get(v);
    if (s && s.a !== null && s.b !== null && v.currentTime >= s.b) v.currentTime = s.a;
    if (rec && rec.video === v) recCheck(v);
  }

  // Media events don't bubble but they do pass through the capture phase.
  for (const type of ['loadedmetadata', 'play', 'playing']) {
    window.addEventListener(type, (e) => {
      const v = e.target;
      if (v && v.tagName === 'VIDEO' && !isLiveFeed(v)) { track(v); if (enabled) startUI(); }
    }, true);
  }

  // ---------- speed / volume primitives ----------
  function setRateRaw(v, r) {
    const s = vstate(v);
    s.ourRateAt = now();
    try { v.playbackRate = r; v.defaultPlaybackRate = r; } catch (e) { /* out of range */ }
  }
  function setSpeed(v, r) {
    r = Math.round(Math.min(16, Math.max(0.07, r)) * 100) / 100;
    const s = vstate(v);
    s.rate = r; s.gaveUp = false; s.fights = 0;
    setRateRaw(v, r);
    if (S.rememberSpeed) saveSite({ speed: r });
    return r;
  }

  // Volume in percent, 0..maxBoost. Above 100% uses Web Audio gain.
  let audioCtx = null;
  let audioReady = false;
  const graphs = new WeakMap();
  const pendingBoost = new Set();
  let lastGesture = 0;

  function canBoost(v) {
    if (v.mediaKeys) return false;
    const src = v.currentSrc || v.src || '';
    if (/^(blob:|data:)/.test(src)) return true;
    if (v.crossOrigin !== null && v.crossOrigin !== undefined) return true;
    try { return new URL(src, location.href).origin === location.origin; } catch (e) { return false; }
  }
  function ensureGraph(v) {
    let gph = graphs.get(v);
    if (gph) return gph;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const src = audioCtx.createMediaElementSource(v);
    const gain = audioCtx.createGain();
    src.connect(gain).connect(audioCtx.destination);
    gph = { src, gain };
    graphs.set(v, gph);
    return gph;
  }
  function applyBoost(v, pct) {
    pendingBoost.delete(v);
    if (!canBoost(v)) return false;
    try { ensureGraph(v).gain.gain.value = pct / 100; return true; } catch (e) { return false; }
  }
  function volumePct(v) {
    const g = graphs.get(v);
    const mult = g ? g.gain.gain.value : 1;
    return Math.round(v.volume * 100 * mult);
  }
  function setVolumePct(v, pct, fromUser) {
    pct = Math.round(Math.min(S.maxBoost, Math.max(0, pct)));
    let note = '';
    if (pct > 100) {
      v.volume = 1;
      if (!applyBoost(v, pct)) { pct = 100; note = 'Boost not available on this video'; }
    } else {
      v.volume = pct / 100;
      const g = graphs.get(v);
      if (g) g.gain.gain.value = 1;
    }
    if (pct > 0 && v.muted) v.muted = false;
    if (fromUser && S.rememberVolume) saveSite({ volume: pct });
    return { pct, note };
  }

  function gesture() {
    lastGesture = now();
    if (!audioReady) {
      audioReady = true;
      for (const v of pendingBoost) if (v.isConnected) applyBoost(v, SITE.volume);
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  window.addEventListener('pointerdown', gesture, true);
  window.addEventListener('keydown', gesture, true);

  // ---------- hover detection ----------
  let hoverVideo = null;     // video under the mouse right now
  let barVideo = null;       // video the bar is attached to
  let lastInteract = 0;
  let pointer = { x: -1, y: -1 };
  let lastTarget = null;
  let pmPending = false;

  // Live camera / screen-share feeds (video calls) are left alone.
  const isLiveFeed = (v) => !!v.srcObject && !v.currentSrc;

  const visibleRect = (v) => {
    if (isLiveFeed(v)) return null;
    const r = v.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) return null;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    const cs = getComputedStyle(v);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    return r;
  };
  const inside = (r, x, y) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  function videoAt(x, y, target) {
    let best = null, bestArea = Infinity;
    const consider = (v) => {
      const r = visibleRect(v);
      if (inside(r, x, y)) {
        const area = r.width * r.height;
        if (area < bestArea) { best = v; bestArea = area; }
      }
    };
    for (let i = 0; i < lightVideos.length; i++) consider(lightVideos[i]);
    for (const v of shadowVideos) consider(v);
    if (best) return best;
    // Videos inside shadow DOM (Reddit and other web-component players): look only when the
    // element under the mouse has a shadow root, so normal pages pay nothing.
    if (target && target.shadowRoot) {
      const found = deepVideoAt(target.shadowRoot, x, y, 0);
      if (found) { shadowVideos.add(found); track(found); return found; }
    }
    return null;
  }
  function deepVideoAt(root, x, y, depth) {
    if (depth > 6 || !root.elementsFromPoint) return null;
    for (const el of root.elementsFromPoint(x, y)) {
      if (el.tagName === 'VIDEO') return el;
      if (el.shadowRoot && el.shadowRoot !== root) {
        const f = deepVideoAt(el.shadowRoot, x, y, depth + 1);
        if (f) return f;
      }
    }
    const v = root.querySelector && root.querySelector('video');
    if (v && inside(visibleRect(v), x, y)) return v;
    return null;
  }

  window.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (!enabled || pmPending) return;
    if (lightVideos.length === 0 && shadowVideos.size === 0 && !(e.target && e.target.shadowRoot && e.target !== lastTarget)) return;
    lastTarget = e.target;
    pmPending = true;
    const target = e.target;
    requestAnimationFrame(() => {
      pmPending = false;
      if (ui && ui.host.contains && pointerOnBar()) { touchBar(); return; }
      const v = videoAt(pointer.x, pointer.y, target);
      hoverVideo = v;
      if (v) { startUI(); showBarFor(v); }
    });
  }, { capture: true, passive: true });

  // ---------- UI ----------
  let ui = null;
  let hideTimer = 0;
  let rafOn = false;
  let lastUi = 0;
  let barHidden = false;     // hidden with the toggle key
  let menuOpen = null;
  let showRemaining = false;
  let dragging = false;

  const SVG = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    back: 'M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z',
    fwd: 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    loop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    pip: 'M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z',
    fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    dl: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  .bar { position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 2px; height: 40px; padding: 0 6px;
    background: rgba(18,18,18,.86); color: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.35);
    font-size: 13px; line-height: 1; user-select: none; opacity: 0; pointer-events: none; transition: opacity .15s; }
  .bar.on { opacity: 1; pointer-events: auto; }
  button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 32px; min-width: 30px; padding: 0 4px;
    border-radius: 7px; cursor: pointer; color: #fff; font-size: 13px; white-space: nowrap; flex-shrink: 0; }
  button:hover, button:focus-visible { background: rgba(255,255,255,.16); }
  button.act { color: #6cb4ff; }
  svg { width: 20px; height: 20px; fill: currentColor; display: block; }
  .time { padding: 0 6px; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; opacity: .95; }
  input[type=range] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 4px; background: rgba(255,255,255,.3); outline: none; cursor: pointer; margin: 0 6px; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #fff; border: 0; }
  .seek { flex: 1; min-width: 40px; }
  .vol { width: 64px; flex-shrink: 0; margin: 0 4px; }
  .time { flex-shrink: 0; }
  .pct { width: 38px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; opacity: .9; }
  .rec { color: #ff5252; font-weight: 600; padding: 0 6px; display: none; }
  .rec.on { display: inline; }
  .menu { position: fixed; z-index: 2147483647; background: rgba(24,24,24,.96); color: #fff; border-radius: 10px; padding: 6px; min-width: 210px;
    box-shadow: 0 6px 24px rgba(0,0,0,.45); font-size: 13px; display: none; max-height: 70vh; overflow: auto; }
  .menu.on { display: block; }
  .menu > button { display: flex; width: 100%; justify-content: flex-start; gap: 8px; height: 32px; padding: 0 8px; }
  .menu.dl { width: 340px; }
  .menu .sep { height: 1px; background: rgba(255,255,255,.12); margin: 5px 2px; }
  .menu .hd { padding: 6px 8px 4px; font-size: 12px; opacity: .7; }
  .menu .note { padding: 6px 8px; font-size: 12px; opacity: .85; line-height: 1.35; white-space: normal; }
  .opt { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; }
  .opt:hover { background: rgba(255,255,255,.08); }
  .opt .txt { flex: 1; min-width: 0; }
  .opt .l { font-weight: 600; }
  .opt .d { font-size: 11.5px; opacity: .75; margin-top: 2px; }
  .opt button { background: #2f7cf6; height: 28px; padding: 0 12px; font-weight: 600; width: auto; }
  .opt button:hover { background: #4b90ff; }
  .opt button.sec { background: rgba(255,255,255,.14); }
  .prog { height: 4px; background: rgba(255,255,255,.15); border-radius: 4px; overflow: hidden; margin: 6px 8px 2px; display: none; }
  .prog.on { display: block; }
  .prog > div { height: 100%; width: 0; background: #2f7cf6; transition: width .2s; }
  .prog.ind > div { width: 30%; animation: ind 1.1s linear infinite; }
  @keyframes ind { from { margin-left: -30%; } to { margin-left: 100%; } }
  .status { padding: 2px 8px 6px; font-size: 12px; opacity: .85; min-height: 14px; }
  .toast { position: fixed; z-index: 2147483647; padding: 10px 16px; border-radius: 10px; background: rgba(18,18,18,.88); color: #fff;
    font-size: 15px; font-weight: 600; pointer-events: none; opacity: 0; transition: opacity .2s; transform: translate(-50%, -50%); white-space: nowrap; }
  .toast.on { opacity: 1; }
  .md .hide-md, .sm .hide-md, .sm .hide-sm { display: none; }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function icon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }
  function btn(cls, title, d, onClick) {
    const b = el('button', cls);
    b.title = title;
    b.setAttribute('aria-label', title);
    if (d) b.appendChild(icon(d));
    b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); touchBar(); onClick(e, b); });
    return b;
  }
  const setIcon = (b, d) => { b.firstChild && b.firstChild.firstChild && b.firstChild.firstChild.setAttribute('d', d); };

  function startUI() {
    if (ui || !enabled || barMode() === 'off' && !shortcutsOn()) return;
    const host = document.createElement('vidfix-ui');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    for (const t of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel', 'keydown', 'contextmenu']) {
      host.addEventListener(t, (e) => e.stopPropagation());
    }

    const bar = el('div', 'bar');
    const play = btn('', 'Play / pause (K)', SVG.play, () => withVideo(togglePlay));
    const back = btn('hide-md', 'Rewind (J)', SVG.back, () => withVideo((v) => seekBy(v, -S.seekStep)));
    const fwd = btn('hide-md', 'Forward (L)', SVG.fwd, () => withVideo((v) => seekBy(v, S.seekStep)));
    const cur = el('span', 'time', '0:00');
    const seek = el('input', 'seek');
    seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.step = 'any'; seek.value = '0';
    seek.title = 'Seek';
    seek.addEventListener('input', () => {
      dragging = true; touchBar();
      const v = barVideo;
      if (v && isFinite(v.duration)) { v.currentTime = (seek.value / 1000) * v.duration; cur.textContent = VF.fmtTime(v.currentTime); }
    });
    seek.addEventListener('change', () => { dragging = false; });
    const total = el('span', 'time hide-sm', '0:00');
    total.title = 'Click to show remaining time';
    total.addEventListener('click', (e) => { e.stopPropagation(); showRemaining = !showRemaining; updateBar(true); });
    const muteB = btn('', 'Mute (M)', SVG.vol, () => withVideo((v) => { v.muted = !v.muted; if (!v.muted && v.volume === 0) setVolumePct(v, 50, true); }));
    const vol = el('input', 'vol hide-sm');
    vol.type = 'range'; vol.min = '0'; vol.max = String(S.maxBoost); vol.step = '1'; vol.title = 'Volume (past 100% = boost)';
    vol.addEventListener('input', () => {
      touchBar();
      withVideo((v) => {
        let val = Number(vol.value);
        if (val > 92 && val < 108) val = 100; // snap to 100%
        const r = setVolumePct(v, val, true);
        pct.textContent = r.pct + '%';
        if (r.note) toast(v, r.note);
      });
    });
    const pct = el('span', 'pct hide-md', '100%');
    const speedB = btn('', 'Speed (S / D, R = reset)', null, () => toggleMenu('speed', speedB));
    speedB.textContent = '1x';
    speedB.addEventListener('wheel', (e) => {
      e.preventDefault();
      withVideo((v) => { const r = setSpeed(v, v.playbackRate + (e.deltaY < 0 ? S.speedStep : -S.speedStep)); speedB.textContent = fmtRate(r); });
    }, { passive: false });
    const recB = el('span', 'rec', '● REC');
    const loopB = btn('hide-md', 'Loop (O)', SVG.loop, () => withVideo(toggleLoop));
    const pipB = btn('hide-md', 'Picture-in-picture (P)', SVG.pip, () => withVideo(togglePip));
    const fsB = btn('', 'Fullscreen (F)', SVG.fs, () => withVideo(toggleFullscreen));
    const dlB = btn('', 'Download / record', SVG.dl, () => withVideo((v) => openDownloads(v)));
    const moreB = btn('', 'More', SVG.more, () => toggleMenu('more', moreB));
    bar.append(play, back, fwd, cur, seek, total, muteB, vol, pct, speedB, recB, loopB, pipB, fsB, dlB, moreB);

    const menu = el('div', 'menu');
    const toastEl = el('div', 'toast');
    root.append(bar, menu, toastEl);
    (document.documentElement || document.body).appendChild(host);
    ui = { host, root, bar, menu, toastEl, play, cur, seek, total, muteB, vol, pct, speedB, recB, loopB, fsB, dlB };
  }

  function placeHost() {
    if (!ui) return;
    const fsEl = document.fullscreenElement;
    const parent = fsEl && fsEl.tagName !== 'VIDEO' ? fsEl : document.documentElement;
    if (ui.host.parentNode !== parent) parent.appendChild(ui.host);
  }

  const fmtRate = (r) => (Math.round(r * 100) / 100) + 'x';

  function withVideo(fn) {
    const v = barVideo && barVideo.isConnected ? barVideo : activeVideo();
    if (v) { lastInteract = now(); fn(v); updateBar(true); }
  }

  function pointerOnBar() {
    if (!ui) return false;
    const els = [ui.bar, ui.menu];
    return els.some((x) => {
      if (!x.classList.contains('on')) return false;
      const r = x.getBoundingClientRect();
      return inside(r, pointer.x, pointer.y);
    });
  }

  function showBarFor(v) {
    if (!ui || barHidden || barMode() === 'off') return;
    if (barVideo !== v) { barVideo = v; closeMenu(); }
    ui.bar.classList.add('on');
    touchBar();
    updateBar(true);
    loop();
  }
  function touchBar() {
    clearTimeout(hideTimer);
    if (barMode() === 'always') return;
    hideTimer = setTimeout(maybeHide, S.autoHideMs);
  }
  function maybeHide() {
    if (!ui) return;
    if (menuOpen || dragging || pointerOnBar() || (rec && rec.video === barVideo)) { touchBar(); return; }
    ui.bar.classList.remove('on');
  }
  function hideBar() {
    if (!ui) return;
    ui.bar.classList.remove('on');
    closeMenu();
  }

  function loop() {
    if (rafOn) return;
    rafOn = true;
    const step = () => {
      if (!ui || !ui.bar.classList.contains('on')) { rafOn = false; return; }
      if (!barVideo || !barVideo.isConnected) { hideBar(); rafOn = false; return; }
      position();
      if (now() - lastUi > 120) updateBar(false);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function position() {
    const v = barVideo;
    const r = v.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.width < 10) { ui.bar.classList.remove('on'); return; }
    placeHost();
    const minW = 300, pad = 6;
    let w = Math.max(minW, Math.min(r.width - pad * 2, 900));
    w = Math.min(w, innerWidth - 8);
    let left = r.left + (r.width - w) / 2;
    left = Math.max(4, Math.min(left, innerWidth - w - 4));
    const h = 40;
    let top = S.barPosition === 'top' ? r.top + pad : r.bottom - h - pad;
    top = Math.max(4, Math.min(top, innerHeight - h - 4));
    const b = ui.bar.style;
    b.left = left + 'px'; b.top = top + 'px'; b.width = w + 'px';
    ui.bar.classList.toggle('md', w < 600 && w >= 440);
    ui.bar.classList.toggle('sm', w < 440);
    if (menuOpen) placeMenu();
  }

  function updateBar(force) {
    if (!ui || !barVideo) return;
    lastUi = now();
    const v = barVideo;
    setIcon(ui.play, v.paused ? SVG.play : SVG.pause);
    const d = v.duration;
    if (!dragging) {
      ui.cur.textContent = VF.fmtTime(v.currentTime);
      ui.seek.value = isFinite(d) && d > 0 ? String((v.currentTime / d) * 1000) : '0';
    }
    ui.seek.disabled = !(isFinite(d) && d > 0);
    ui.total.textContent = !isFinite(d) ? 'LIVE' : showRemaining ? '-' + VF.fmtTime(d - v.currentTime) : VF.fmtTime(d);
    const p = v.muted ? 0 : volumePct(v);
    setIcon(ui.muteB, v.muted || p === 0 ? SVG.mute : SVG.vol);
    if (force || ui.root.activeElement !== ui.vol) { ui.vol.max = String(S.maxBoost); ui.vol.value = String(p); }
    ui.pct.textContent = p + '%';
    ui.speedB.textContent = fmtRate(v.playbackRate);
    ui.loopB.classList.toggle('act', v.loop || (vstate(v).a !== null));
    ui.recB.classList.toggle('on', !!(rec && rec.video === v));
    if (rec && rec.video === v) ui.recB.textContent = '● REC ' + VF.fmtTime((now() - rec.t0) / 1000);
  }

  // ---------- menus ----------
  function closeMenu() {
    if (!ui) return;
    menuOpen = null;
    ui.menu.classList.remove('on', 'dl');
    ui.menu.textContent = '';
  }
  function placeMenu() {
    if (!menuOpen || !menuOpen.anchor) return;
    const a = menuOpen.anchor.getBoundingClientRect();
    const m = ui.menu;
    const mw = m.offsetWidth || 220, mh = m.offsetHeight || 100;
    let left = Math.min(a.right - mw, innerWidth - mw - 6);
    left = Math.max(6, left);
    let top = a.top - mh - 8;
    if (top < 6) top = Math.min(innerHeight - mh - 6, a.bottom + 8);
    m.style.left = left + 'px';
    m.style.top = Math.max(6, top) + 'px';
  }
  function toggleMenu(kind, anchor) {
    if (menuOpen && menuOpen.kind === kind) { closeMenu(); return; }
    openMenu(kind, anchor);
  }
  function openMenu(kind, anchor) {
    if (!ui) return;
    closeMenu();
    menuOpen = { kind, anchor };
    const m = ui.menu;
    const v = barVideo;
    const item = (label, fn, active) => {
      const b = el('button', active ? 'act' : '', label);
      b.addEventListener('click', (e) => { e.stopPropagation(); touchBar(); fn(); });
      m.appendChild(b);
      return b;
    };
    if (kind === 'speed') {
      m.appendChild(el('div', 'hd', 'Playback speed'));
      for (const r of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
        item(r === 1 ? '1x (normal)' : r + 'x', () => { setSpeed(v, r); closeMenu(); updateBar(true); }, Math.abs(v.playbackRate - r) < 0.01);
      }
    } else if (kind === 'more') {
      item('Save screenshot (G)', () => { closeMenu(); screenshot(v); });
      item(rec && rec.video === v ? 'Stop recording' : 'Record video...', () => { if (rec && rec.video === v) stopRecording(); else openDownloads(v, true); });
      m.appendChild(el('div', 'sep'));
      const s = vstate(v);
      item(s.a === null ? 'Repeat A-B: set A (B)' : s.b === null ? 'Repeat A-B: set B (B)' : 'Repeat A-B: clear (B)', () => { closeMenu(); abLoop(v); });
      item('Previous frame (,)', () => frameStep(v, -1));
      item('Next frame (.)', () => frameStep(v, 1));
      item('Picture-in-picture (P)', () => { closeMenu(); togglePip(v); });
      item(v.controls ? 'Hide the browser\'s own controls' : 'Show the browser\'s own controls', () => { v.controls = !v.controls; closeMenu(); });
      m.appendChild(el('div', 'sep'));
      item('Turn off VidFix on ' + HOST, () => {
        closeMenu();
        const list = S.disabledSites.concat([HOST]);
        chrome.storage.sync.set({ settings: Object.assign({}, S, { disabledSites: list }) });
      });
      item('Settings and shortcuts', () => { closeMenu(); chrome.runtime.sendMessage({ type: 'vf:options' }); });
    }
    m.classList.add('on');
    placeMenu();
  }

  // ---------- download panel ----------
  let job = null;
  function fileBase() {
    const t = VF.safeFileName(document.title, HOST);
    return `${t} ${VF.stamp()}`;
  }
  function saveParts(parts, ext, base) {
    const type = ext === 'webm' ? 'video/webm' : ext === 'm4a' ? 'audio/mp4' : ext === 'ts' ? 'video/mp2t' : ext === 'png' ? 'image/png' : 'video/mp4';
    const blob = parts instanceof Blob ? parts : new Blob(parts, { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = base + '.' + ext;
    (ui ? ui.root : document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  async function openDownloads(v, recordOnly) {
    startUI();
    if (!ui) return;
    if (barVideo !== v) { barVideo = v; }
    ui.bar.classList.add('on');
    loop();
    closeMenu();
    menuOpen = { kind: 'dl', anchor: ui.dlB };
    const m = ui.menu;
    m.classList.add('on', 'dl');
    m.appendChild(el('div', 'hd', recordOnly ? 'Record this video' : 'Save this video'));
    const list = el('div');
    const prog = el('div', 'prog');
    prog.appendChild(el('div'));
    const status = el('div', 'status', recordOnly ? '' : 'Looking for the best way to save it...');
    m.append(list, prog, status);
    placeMenu();

    const setProgress = (f, text) => {
      prog.classList.add('on');
      prog.classList.toggle('ind', f === null || f === undefined);
      if (f !== null && f !== undefined) prog.firstChild.style.width = Math.round(f * 100) + '%';
      status.textContent = text || (f !== null && f !== undefined ? 'Downloading ' + Math.round(f * 100) + '%' : 'Working...');
      placeMenu();
    };
    const optRow = (label, detail, btnText, fn, secondary) => {
      const row = el('div', 'opt');
      const txt = el('div', 'txt');
      txt.append(el('div', 'l', label), el('div', 'd', detail || ''));
      const b = el('button', secondary ? 'sec' : '', btnText);
      b.addEventListener('click', (e) => { e.stopPropagation(); touchBar(); fn(b); });
      row.append(txt, b);
      list.appendChild(row);
      return row;
    };
    const recordRows = () => {
      if (v.mediaKeys) return;
      if (rec && rec.video === v) {
        optRow('Recording...', 'Click Stop to save it now', 'Stop', () => stopRecording());
        return;
      }
      optRow('Record from the start', 'Plays the video and saves it in real time. Works on almost any site.', 'Record', () => startRecording(v, true), !recordOnly);
      optRow('Record from here', 'Starts at the current position', 'Record', () => startRecording(v, false), true);
    };

    if (recordOnly) {
      if (VF.siteRule(location.hostname).noDownload) {
        m.appendChild(el('div', 'note', 'Saving videos from YouTube is not allowed by the Chrome Web Store rules, so it is turned off here.'));
        status.textContent = '';
      } else recordRows();
      placeMenu();
      return;
    }

    const ctrl = new AbortController();
    const ctx = { signal: ctrl.signal, fileBase: fileBase(), onProgress: setProgress };
    let found;
    try { found = await VF.sources.forVideo(v, ctx); } catch (e) { found = { options: [], others: [] }; }
    if (!menuOpen || menuOpen.kind !== 'dl') return;
    status.textContent = '';
    if (found.blocked === 'youtube') {
      m.insertBefore(el('div', 'note', 'Saving videos from YouTube is not allowed by the Chrome Web Store rules, so it is turned off here. All the other controls still work.'), list);
      placeMenu();
      return;
    }
    if (found.protected) {
      m.insertBefore(el('div', 'note', 'This video is DRM-protected (like Netflix or Prime Video). It cannot be saved.'), list);
      placeMenu();
      return;
    }
    const run = async (opt, b) => {
      if (job) { status.textContent = 'Another download is still running.'; return; }
      job = ctrl;
      b.textContent = 'Cancel';
      const cancel = (e) => { e.stopPropagation(); ctrl.abort(); };
      b.addEventListener('click', cancel, { once: true, capture: true });
      setProgress(null, 'Starting...');
      try {
        const out = await opt.run(ctx);
        if (out && out.parts) {
          setProgress(1, 'Saving file...');
          saveParts(out.parts, out.ext, ctx.fileBase);
          if (out.extra) saveParts(out.extra.parts, out.extra.ext, ctx.fileBase + ' (' + out.extra.label + ')');
          setProgress(1, out.extra ? 'Saved (video and sound as two files).' : 'Saved to your Downloads folder.');
        } else {
          setProgress(1, 'Download started. Check your Downloads.');
        }
      } catch (e) {
        prog.classList.remove('on');
        status.textContent = ctrl.signal.aborted ? 'Cancelled.' : 'Could not save: ' + (e && e.message ? e.message : e) + ' Try Record instead.';
      } finally {
        job = null;
        b.textContent = 'Done';
        b.disabled = true;
      }
      placeMenu();
    };
    const shown = found.options.filter((o) => o.type !== 'note' || o.match !== false);
    for (const o of shown) {
      if (o.type === 'note') optRow(o.label, o.detail, '-', () => {}, true);
      else optRow(o.label, o.detail + (o.match === true ? '' : o.match === null ? ' (could be another video on this page)' : ''), 'Save', (b) => run(o, b));
    }
    if (!shown.length) m.insertBefore(el('div', 'note', 'No direct file found for this video. Use Record below, it works on almost any site.'), list);
    recordRows();
    if (found.others.length) {
      const more = el('button', '', `Show ${found.others.length} other stream(s) on this page`);
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        more.remove();
        for (const o of found.others) if (o.type !== 'note') optRow(o.label, o.detail + ' (other video)', 'Save', (b) => run(o, b), true);
        placeMenu();
      });
      list.appendChild(more);
    }
    placeMenu();
  }

  // ---------- recording ----------
  let rec = null;
  function pickMime() {
    // Real H.264/AAC MP4 when Chrome can encode it (plays everywhere), otherwise WebM.
    const c = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }
  async function startRecording(v, fromStart) {
    if (rec) { toast(v, 'Already recording'); return; }
    let stream;
    try { stream = v.captureStream ? v.captureStream() : null; } catch (e) { stream = null; }
    if (!stream) { toast(v, 'This video cannot be recorded'); return; }
    const mime = pickMime();
    let mr;
    try {
      mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000, audioBitsPerSecond: 192000 });
    } catch (e) { toast(v, 'Recording is not supported here'); return; }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const base = fileBase();
    mr.onstop = () => {
      const ext = (mr.mimeType || mime).includes('mp4') ? 'mp4' : 'webm';
      if (chunks.length) saveParts(new Blob(chunks, { type: mr.mimeType || mime }), ext, base + ' (recording)');
      toast(v, chunks.length ? 'Recording saved' : 'Nothing was recorded');
      updateBar(true);
    };
    rec = { video: v, mr, t0: now(), last: v.currentTime, wasLoop: v.loop };
    closeMenu();
    if (fromStart) { try { v.currentTime = 0; } catch (e) { /* ignore */ } }
    v.loop = false;
    vstate(v).allowPlayUntil = now() + 2000;
    try { await v.play(); } catch (e) { /* user can press play */ }
    mr.start(1000);
    v.addEventListener('ended', stopRecording, { once: true });
    toast(v, 'Recording... press Stop in the menu or let it finish');
    updateBar(true);
  }
  function recCheck(v) {
    // Players that loop the video by themselves (reels) never fire "ended": stop when it jumps back.
    if (v.currentTime + 1 < rec.last && rec.last > 2) { stopRecording(); return; }
    rec.last = v.currentTime;
  }
  function stopRecording() {
    if (!rec) return;
    const r = rec;
    rec = null;
    r.video.loop = r.wasLoop;
    try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch (e) { /* ignore */ }
  }

  // ---------- screenshot ----------
  async function screenshot(v) {
    const name = fileBase() + ' (frame ' + VF.fmtTime(v.currentTime).replace(/:/g, '-') + ')';
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      if (!c.width) throw new Error('no frame');
      c.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise((res, rej) => { try { c.toBlob((b) => (b ? res(b) : rej(new Error('blocked'))), 'image/png'); } catch (e) { rej(e); } });
      saveParts(blob, 'png', name);
      toast(v, 'Screenshot saved');
    } catch (e) {
      if (!IS_TOP) { toast(v, 'Screenshot blocked by this site'); return; }
      // Fallback: grab the visible tab and crop to the video.
      const r = v.getBoundingClientRect();
      const wasOn = ui && ui.bar.classList.contains('on');
      if (ui) { ui.bar.classList.remove('on'); closeMenu(); }
      await new Promise((res) => setTimeout(res, 80));
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'vf:capture' });
        if (!resp || !resp.dataUrl) throw new Error(resp && resp.error ? resp.error : 'capture failed');
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = resp.dataUrl; });
        const k = img.width / innerWidth;
        const c = document.createElement('canvas');
        const x = Math.max(0, r.left), y = Math.max(0, r.top);
        const w = Math.min(r.right, innerWidth) - x, h = Math.min(r.bottom, innerHeight) - y;
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, x * k, y * k, w * k, h * k, 0, 0, c.width, c.height);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        saveParts(blob, 'png', name);
        toast(v, 'Screenshot saved');
      } catch (err) {
        toast(v, 'Screenshot not possible here');
      }
      if (wasOn && ui) ui.bar.classList.add('on'), loop();
    }
  }

  // ---------- actions ----------
  function togglePlay(v) {
    if (v.paused || v.ended) { vstate(v).allowPlayUntil = now() + 1500; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    else v.pause();
  }
  function seekBy(v, d) {
    if (!isFinite(v.duration)) { try { v.currentTime = Math.max(0, v.currentTime + d); } catch (e) { /* ignore */ } return; }
    v.currentTime = Math.min(v.duration - 0.05, Math.max(0, v.currentTime + d));
    toast(v, (d > 0 ? '+' : '') + d + 's');
  }
  function toggleLoop(v) {
    const s = vstate(v);
    if (s.a !== null) { s.a = s.b = null; toast(v, 'Repeat off'); return; }
    v.loop = !v.loop;
    toast(v, v.loop ? 'Loop on' : 'Loop off');
  }
  function abLoop(v) {
    const s = vstate(v);
    if (s.a === null) { s.a = v.currentTime; toast(v, 'A set at ' + VF.fmtTime(s.a)); }
    else if (s.b === null) {
      if (v.currentTime <= s.a + 0.3) { toast(v, 'B must be after A'); return; }
      s.b = v.currentTime; v.currentTime = s.a; toast(v, 'Repeating ' + VF.fmtTime(s.a) + ' - ' + VF.fmtTime(s.b));
    } else { s.a = s.b = null; toast(v, 'Repeat off'); }
  }
  function frameStep(v, dir) {
    if (!v.paused) v.pause();
    v.currentTime = Math.max(0, v.currentTime + dir / 30);
  }
  async function togglePip(v) {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else { v.disablePictureInPicture = false; await v.requestPictureInPicture(); }
    } catch (e) { toast(v, 'Picture-in-picture not available here'); }
  }
  function toggleFullscreen(v) {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const s = vstate(v);
    s.hadControls = v.controls;
    v.controls = true; // the browser's own controls work in fullscreen
    v.requestFullscreen().catch(() => { v.controls = s.hadControls; s.hadControls = null; toast(v, 'Fullscreen blocked by this site'); });
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      for (const v of allVideos(false)) {
        const s = st.get(v);
        if (s && s.hadControls !== null) { v.controls = s.hadControls; s.hadControls = null; }
      }
    }
    placeHost();
  });

  let toastTimer = 0;
  function toast(v, text) {
    startUI();
    if (!ui) return;
    const r = v && v.getBoundingClientRect ? v.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    placeHost();
    const t = ui.toastEl;
    t.textContent = text;
    t.style.left = Math.min(innerWidth - 60, Math.max(60, r.left + r.width / 2)) + 'px';
    t.style.top = Math.min(innerHeight - 30, Math.max(30, r.top + r.height / 2)) + 'px';
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 1100);
  }

  // ---------- keyboard ----------
  function editable(e) {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(t.type);
    return t.getAttribute && t.getAttribute('role') === 'textbox';
  }
  function activeVideo() {
    const fs = document.fullscreenElement;
    if (fs) {
      if (fs.tagName === 'VIDEO') return fs;
      const inFs = allVideos(false).find((v) => fs.contains(v));
      if (inFs) return inFs;
    }
    if (document.pictureInPictureElement) return document.pictureInPictureElement;
    if (hoverVideo && hoverVideo.isConnected && inside(visibleRect(hoverVideo), pointer.x, pointer.y)) return hoverVideo;
    if (barVideo && barVideo.isConnected && now() - lastInteract < 15000 && visibleRect(barVideo)) return barVideo;
    return null;
  }
  function onKey(e) {
    if (e.code === 'Escape' && menuOpen) { closeMenu(); return; }
    if (!enabled || !shortcutsOn() || e.ctrlKey || e.altKey || e.metaKey || e.repeat && /^(playPause|fullscreen|pip|loop|abLoop|screenshot|toggleBar|mute)$/.test(actionFor(e.code))) return;
    if (editable(e)) return;
    const action = actionFor(e.code);
    if (!action) return;
    const v = activeVideo();
    if (!v) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    lastInteract = now();
    runAction(action, v);
  }
  const actionFor = (code) => {
    for (const k in S.keys) if (S.keys[k] === code) return k;
    return null;
  };
  function runAction(action, v) {
    switch (action) {
      case 'playPause': togglePlay(v); toast(v, v.paused ? 'Paused' : 'Play'); break;
      case 'back': seekBy(v, -S.seekStep); break;
      case 'forward': seekBy(v, S.seekStep); break;
      case 'slower': toast(v, fmtRate(setSpeed(v, v.playbackRate - S.speedStep))); break;
      case 'faster': toast(v, fmtRate(setSpeed(v, v.playbackRate + S.speedStep))); break;
      case 'resetSpeed': toast(v, fmtRate(setSpeed(v, 1))); break;
      case 'mute': v.muted = !v.muted; toast(v, v.muted ? 'Muted' : 'Sound on'); break;
      case 'volDown': { const r = setVolumePct(v, volumePct(v) - 10, true); toast(v, 'Volume ' + r.pct + '%'); break; }
      case 'volUp': { const r = setVolumePct(v, (v.muted ? 0 : volumePct(v)) + 10, true); toast(v, r.note || 'Volume ' + r.pct + '%'); break; }
      case 'fullscreen': toggleFullscreen(v); break;
      case 'pip': togglePip(v); break;
      case 'frameBack': frameStep(v, -1); break;
      case 'frameFwd': frameStep(v, 1); break;
      case 'loop': toggleLoop(v); break;
      case 'abLoop': abLoop(v); break;
      case 'screenshot': screenshot(v); break;
      case 'toggleBar':
        barHidden = !barHidden;
        if (barHidden) hideBar(); else { startUI(); showBarFor(v); }
        toast(v, barHidden ? 'Controls hidden (H)' : 'Controls shown');
        break;
    }
    if (ui && barVideo === v) updateBar(true);
  }
  window.addEventListener('keydown', onKey, true);

  // Close menus on outside click.
  window.addEventListener('pointerdown', (e) => {
    if (menuOpen && ui && !e.composedPath().includes(ui.host)) closeMenu();
  }, true);

  // "Always" mode: keep the bar on the main visible video.
  let alwaysTimer = 0;
  function alwaysTick() {
    if (!enabled || barMode() !== 'always' || barHidden) return;
    let best = null, bestScore = 0;
    for (const v of allVideos(false)) {
      const r = visibleRect(v);
      if (!r) continue;
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      const score = w * h * (v.paused ? 1 : 2);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (best && best !== barVideo && !menuOpen) { startUI(); showBarFor(best); }
    else if (best && ui && !ui.bar.classList.contains('on')) showBarFor(best);
  }

  // ---------- messages from the popup ----------
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'vf:list') {
      const vids = allVideos(true).filter((v) => !isLiveFeed(v) && (v.readyState > 0 || v.currentSrc));
      if (!vids.length) return false;
      reply({
        frame: IS_TOP ? 'top' : location.hostname, enabled, host: HOST,
        videos: vids.map((v) => ({ id: idOf(v), w: v.videoWidth, h: v.videoHeight, duration: v.duration, time: v.currentTime,
          paused: v.paused, muted: v.muted, rate: v.playbackRate, volume: volumePct(v), visible: !!visibleRect(v),
          protected: !!v.mediaKeys }))
      });
      return false;
    }
    if (msg.type === 'vf:act') {
      const ref = byId.get(msg.id);
      const v = ref && ref.deref();
      if (!v) return false;
      lastInteract = now();
      if (msg.action === 'speed') setSpeed(v, msg.value);
      else if (msg.action === 'volume') setVolumePct(v, msg.value, true);
      else if (msg.action === 'show' || msg.action === 'download') {
        v.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => { startUI(); barHidden = false; showBarFor(v); if (msg.action === 'download') openDownloads(v); }, 450);
      } else runAction(msg.action, v);
      reply({ ok: true, rate: v.playbackRate, volume: volumePct(v) });
      return false;
    }
    return false;
  });

  // ---------- start ----------
  function applyEnabled() {
    const was = enabled;
    enabled = isEnabledHere();
    if (enabled && !started) {
      started = true;
      allVideos(false).forEach((v) => applyPrefs(v));
    }
    if (!enabled && was) { hideBar(); if (ui) { ui.host.remove(); ui = null; } }
    clearInterval(alwaysTimer);
    if (enabled && barMode() === 'always') alwaysTimer = setInterval(alwaysTick, 700);
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync' && ch.settings) {
      S = VF.mergeSettings(ch.settings.newValue);
      if (ui) { ui.vol.max = String(S.maxBoost); }
      applyEnabled();
    }
    if (area === 'local' && ch['site:' + HOST]) SITE = ch['site:' + HOST].newValue || {};
  });

  loadSettings().then(applyEnabled);
})();
