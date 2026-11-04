/* VidFix - shared settings and site rules (used by content scripts, popup and options). */
(function (g) {
  'use strict';
  const VF = g.VF || (g.VF = {});

  // Keyboard actions: [id, label, default key code]. Codes are layout-independent (KeyboardEvent.code),
  // so Caps Lock and Shift never break them.
  VF.KEY_ACTIONS = [
    ['playPause', 'Play / pause', 'KeyK'],
    ['back', 'Rewind', 'KeyJ'],
    ['forward', 'Fast forward', 'KeyL'],
    ['slower', 'Slower', 'KeyS'],
    ['faster', 'Faster', 'KeyD'],
    ['resetSpeed', 'Reset speed to 1x', 'KeyR'],
    ['mute', 'Mute / unmute', 'KeyM'],
    ['volDown', 'Volume down', 'Minus'],
    ['volUp', 'Volume up (past 100% = boost)', 'Equal'],
    ['fullscreen', 'Fullscreen', 'KeyF'],
    ['pip', 'Picture-in-picture', 'KeyP'],
    ['frameBack', 'Previous frame (when paused)', 'Comma'],
    ['frameFwd', 'Next frame (when paused)', 'Period'],
    ['loop', 'Loop on / off', 'KeyO'],
    ['abLoop', 'A-B repeat (set A, set B, clear)', 'KeyB'],
    ['screenshot', 'Save screenshot', 'KeyG'],
    ['toggleBar', 'Show / hide control bar', 'KeyH']
  ];

  VF.DEFAULTS = {
    enabled: true,
    disabledSites: [],
    barMode: 'hover',        // hover | always | off
    barPosition: 'bottom',   // bottom | top
    autoHideMs: 2500,
    seekStep: 5,
    speedStep: 0.1,
    maxBoost: 300,           // percent
    rememberSpeed: true,
    rememberVolume: true,
    lockSpeed: true,
    startUnmuted: false,
    blockAutoplay: false,
    shortcutsEnabled: true,
    keys: Object.fromEntries(VF.KEY_ACTIONS.map(([id, , code]) => [id, code]))
  };

  VF.cloneDefaults = () => JSON.parse(JSON.stringify(VF.DEFAULTS));

  VF.mergeSettings = (saved) => {
    const s = VF.cloneDefaults();
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(s)) if (k in saved && k !== 'keys') s[k] = saved[k];
      if (saved.keys) Object.assign(s.keys, saved.keys);
    }
    return s;
  };

  // Sites with their own good player get a lighter touch by default.
  // YouTube: the Chrome Web Store does not allow extensions that download YouTube videos.
  const YT = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|youtubekids\.com)$/i;
  VF.siteRule = (hostname) => {
    if (YT.test(hostname)) return { barMode: 'off', shortcuts: false, noDownload: 'youtube' };
    return {};
  };
  VF.isBlockedMediaUrl = (url) => /(^|\.)googlevideo\.com$/i.test(safeHost(url)) || YT.test(safeHost(url));
  function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }

  VF.hostKey = (hostname) => (hostname || '').replace(/^www\./, '');

  VF.keyLabel = (code) => {
    if (!code) return '(none)';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const map = { Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
      BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Space: 'Space',
      ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
    return map[code] || code;
  };

  VF.fmtTime = (s) => {
    if (!isFinite(s) || s < 0) return '--:--';
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(x).padStart(2, '0');
  };

  VF.safeFileName = (s, fallback) => {
    s = String(s || '').replace(/^\(\d+\)\s*/, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) s = fallback || 'video';
    return s.slice(0, 90).trim();
  };

  VF.stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  };
})(globalThis);
