/* VidFix - notes which video streams this frame loads (uses the page's own Resource Timing list).
   Nothing is sent anywhere: the list stays in this tab and is only read when you open "Download". */
(function () {
  'use strict';
  if (window.__vfNet) return;
  const entries = new Map();
  window.__vfNet = { entries };

  const SEGMENT = /(^|[\/_-])(seg|segment|chunk|frag|fragment|init)[-_]?\d*\.(mp4|m4s|m4v|m4a)$|\.m4s$|\.ts$|\.aac$/i;

  function consider(name) {
    if (!name || name.charCodeAt(0) !== 104) return; // must start with "h" (http/https)
    let u;
    try { u = new URL(name); } catch (e) { return; }
    const path = u.pathname.toLowerCase();
    let kind = null;
    if (path.endsWith('.m3u8')) kind = 'hls';
    else if (path.endsWith('.mpd')) kind = 'dash';
    else if (u.searchParams.has('bytestart') && u.searchParams.has('byteend')) kind = 'ranged';
    else if (/\.(mp4|m4v|webm|mov|mkv)$/.test(path) && !SEGMENT.test(path)) kind = 'file';
    if (!kind) return;
    if (kind === 'ranged') {
      u.searchParams.delete('bytestart');
      u.searchParams.delete('byteend');
    }
    const key = u.toString();
    const now = performance.now();
    const e = entries.get(key);
    if (e) { e.last = now; e.hits++; return; }
    entries.set(key, { url: key, kind, first: now, last: now, hits: 1 });
    if (entries.size > 400) entries.delete(entries.keys().next().value);
  }

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) consider(e.name);
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {
    try { for (const r of performance.getEntriesByType('resource')) consider(r.name); } catch (e2) { /* ignore */ }
  }
})();
