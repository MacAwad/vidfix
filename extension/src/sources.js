/* VidFix - works out the ways a given <video> can be saved, best first.
   Order: direct file > stream (HLS) > split video+audio (merged) > page data > record. */
(function (g) {
  'use strict';
  const VF = g.VF || (g.VF = {});

  const isHttp = (u) => /^https?:/i.test(u || '');

  function durationMatch(a, b) {
    if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return null;
    return Math.abs(a - b) <= Math.max(1.5, a * 0.03);
  }

  function decodeEfg(url) {
    try {
      const efg = new URL(url).searchParams.get('efg');
      if (!efg) return null;
      let b = efg.replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      return JSON.parse(atob(b));
    } catch (e) { return null; }
  }

  async function fetchWithProgress(url, onBytes, signal, extraInit) {
    const r = await fetch(url, Object.assign({ signal }, extraInit || {}));
    if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || 0;
    if (!r.body) return new Uint8Array(await r.arrayBuffer());
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (onBytes) onBytes(got, total);
    }
    return VF.mp4.concat(chunks);
  }

  // Read the start of a split (DASH-style) file to learn: video or audio, quality, duration.
  async function probeRanged(url, signal) {
    const efg = decodeEfg(url);
    const info = { url, kind: null, height: 0, duration: NaN, asset: null, label: '' };
    if (efg) {
      const tag = String(efg.vencode_tag || '');
      info.kind = /audio/i.test(tag) ? 'audio' : (tag ? 'video' : null);
      const m = tag.match(/(\d{3,4})p/);
      if (m) info.height = Number(m[1]);
      if (efg.duration_s) info.duration = Number(efg.duration_s);
      info.asset = efg.xpv_asset_id || efg.video_id || null;
    }
    if (!info.kind || !isFinite(info.duration)) {
      for (const size of [131072, 1048576]) {
        try {
          const u = new URL(url);
          let bytes;
          if (efg || /fbcdn|cdninstagram/.test(u.hostname)) {
            u.searchParams.set('bytestart', '0');
            u.searchParams.set('byteend', String(size - 1));
            bytes = await fetchWithProgress(u.toString(), null, signal);
          } else {
            bytes = await fetchWithProgress(url, null, signal, { headers: { Range: `bytes=0-${size - 1}` } });
          }
          const p = VF.mp4.parse(bytes.length > size ? bytes.subarray(0, size) : bytes);
          if (!p.moov) continue;
          const v = p.tracks.find((t) => t.handler === 'vide');
          const a = p.tracks.find((t) => t.handler === 'soun');
          info.kind = v && a ? 'both' : v ? 'video' : a ? 'audio' : null;
          if (v && v.height) info.height = Math.round(v.height);
          if (p.bestDuration) info.duration = p.bestDuration;
          info.encrypted = p.encrypted;
          break;
        } catch (e) {
          if (signal && signal.aborted) throw e;
        }
      }
    }
    return info;
  }

  function fbProgressive() {
    const host = location.hostname;
    if (!/(^|\.)(facebook\.com|instagram\.com)$/.test(host)) return [];
    const keys = ['browser_native_hd_url', 'playable_url_quality_hd', 'hd_src', 'browser_native_sd_url', 'playable_url', 'sd_src'];
    const found = [], seen = new Set();
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || t.length < 100 || t.indexOf('_url') < 0 && t.indexOf('_src') < 0) continue;
      for (const k of keys) {
        const re = new RegExp('"' + k + '":"(https:[^"]+)"', 'g');
        let m;
        while ((m = re.exec(t)) && found.length < 12) {
          let url;
          try { url = JSON.parse('"' + m[1] + '"'); } catch (e) { continue; }
          if (seen.has(url)) continue;
          seen.add(url);
          found.push({ url, hd: /hd/.test(k) });
        }
      }
    }
    return found;
  }

  /**
   * Returns { blocked, protected, options: [...], others: [...] }.
   * Each option: { label, detail, match, type, run(ctx) } where ctx = { onProgress(fraction|null, text), signal }.
   * run() resolves to { parts, ext } (to save as a file) or { started: true } (download handed to the browser).
   */
  async function forVideo(video, ctx) {
    const res = { blocked: null, protected: false, options: [], others: [] };
    const rule = VF.siteRule(location.hostname);
    if (rule.noDownload) { res.blocked = rule.noDownload; return res; }
    if (video.mediaKeys) { res.protected = true; return res; }
    const dur = video.duration;
    const add = (opt) => {
      if (opt.match === false) res.others.push(opt); else res.options.push(opt);
    };

    // 1) Direct file URL on the element itself.
    const direct = new Set();
    for (const u of [video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source')).map((s) => s.src)]) {
      if (isHttp(u) && !VF.isBlockedMediaUrl(u)) direct.add(u);
    }
    for (const u of direct) {
      if (/\.m3u8(\?|$)/i.test(u)) continue; // handled as a stream below
      add({ type: 'direct', label: 'Video file', detail: 'Original file, fastest', match: true,
        run: async () => {
          await chrome.runtime.sendMessage({ type: 'vf:download', url: u, filename: ctx.fileBase + '.' + guessExt(u, 'mp4') });
          return { started: true };
        } });
    }

    const net = (window.__vfNet && Array.from(window.__vfNet.entries.values())) || [];
    net.sort((a, b) => b.last - a.last);
    const hlsUrls = new Set(net.filter((e) => e.kind === 'hls').map((e) => e.url));
    for (const u of direct) if (/\.m3u8(\?|$)/i.test(u)) hlsUrls.add(u);

    // 2) HLS streams.
    const hlsInfos = await Promise.all(Array.from(hlsUrls).slice(0, 8).map((u) =>
      VF.hls.inspect(u, ctx.signal).catch(() => null)));
    const masters = hlsInfos.filter(Boolean);
    // Media playlists that belong to a master we already have are skipped.
    const childUrls = new Set();
    for (const i of masters) {
      if (!i.master) continue;
      for (const v of i.master.variants) childUrls.add(v.uri);
      for (const g of Object.values(i.master.audios)) for (const a of g) if (a.uri) childUrls.add(a.uri);
    }
    for (const info of masters) {
      if (!info.master && childUrls.has(info.url)) continue;
      if (VF.isBlockedMediaUrl(info.url)) continue;
      const match = durationMatch(dur, info.duration);
      if (info.encrypted) { add({ type: 'note', label: 'Protected stream', detail: 'Encrypted, cannot be saved', match }); continue; }
      if (info.live) continue;
      const variants = info.master ? info.master.variants.slice(0, 4) : [null];
      variants.forEach((v, idx) => {
        const q = v && v.height ? v.height + 'p' : '';
        add({ type: 'hls', label: idx === 0 ? (q ? `Best quality (${q})` : 'Full video') : q,
          detail: `HLS stream${isFinite(info.duration) ? ', ' + VF.fmtTime(info.duration) : ''}`, match,
          run: async () => VF.hls.download(info.url, idx, (f) => ctx.onProgress(f), ctx.signal) });
      });
    }

    // 3) Split video + audio files (Facebook / Instagram and other DASH players).
    const ranged = net.filter((e) => e.kind === 'ranged' && !VF.isBlockedMediaUrl(e.url)).slice(0, 16);
    if (ranged.length) {
      const probes = (await Promise.all(ranged.map((e) => probeRanged(e.url, ctx.signal).catch(() => null)))).filter(Boolean);
      const groups = new Map();
      for (const p of probes) {
        if (p.encrypted) continue;
        const key = p.asset || (isFinite(p.duration) ? Math.round(p.duration * 2) / 2 : 'x');
        if (!groups.has(key)) groups.set(key, { videos: [], audios: [], both: [], duration: p.duration });
        const gr = groups.get(key);
        if (p.kind === 'video') gr.videos.push(p);
        else if (p.kind === 'audio') gr.audios.push(p);
        else if (p.kind === 'both') gr.both.push(p);
        if (!isFinite(gr.duration)) gr.duration = p.duration;
      }
      for (const gr of groups.values()) {
        gr.videos.sort((a, b) => b.height - a.height);
        const match = durationMatch(dur, gr.duration);
        const durTxt = isFinite(gr.duration) ? ', ' + VF.fmtTime(gr.duration) : '';
        for (const b of gr.both) {
          add({ type: 'file', label: `Video${b.height ? ' ' + b.height + 'p' : ''}`, detail: 'With sound' + durTxt, match,
            run: async () => ({ parts: [await fetchWithProgress(b.url, bytesProgress(ctx), ctx.signal)], ext: 'mp4' }) });
        }
        const v = gr.videos[0], a = gr.audios[0];
        if (v && a) {
          add({ type: 'merge', label: `Best quality${v.height ? ' (' + v.height + 'p)' : ''}`, detail: 'Video + sound joined into one file' + durTxt, match,
            run: async () => {
              let vd = 0, ad = 0, vt = 0, at = 0;
              const upd = () => ctx.onProgress(vt + at ? (vd + ad) / (vt + at) : null, VF.fmtBytes(vd + ad));
              const [vb, ab] = await Promise.all([
                fetchWithProgress(v.url, (got, tot) => { vd = got; vt = tot; upd(); }, ctx.signal),
                fetchWithProgress(a.url, (got, tot) => { ad = got; at = tot; upd(); }, ctx.signal)
              ]);
              ctx.onProgress(null, 'Joining video and sound...');
              try { return { parts: VF.mp4.merge(vb, ab), ext: 'mp4' }; } catch (e) {
                return { parts: [vb], ext: 'mp4', extra: { parts: [ab], ext: 'm4a', label: 'audio' } };
              }
            } });
        } else if (v) {
          add({ type: 'file', label: `Video only${v.height ? ' (' + v.height + 'p)' : ''}`, detail: 'No sound track found' + durTxt, match,
            run: async () => ({ parts: [await fetchWithProgress(v.url, bytesProgress(ctx), ctx.signal)], ext: 'mp4' }) });
        }
      }
    }

    // 4) Plain video files the player fetched itself.
    for (const e of net.filter((x) => x.kind === 'file' && !direct.has(x.url) && !VF.isBlockedMediaUrl(x.url)).slice(0, 4)) {
      add({ type: 'direct', label: 'Video file', detail: shortName(e.url), match: dur > 0 && net.length <= 2 ? true : null,
        run: async () => {
          await chrome.runtime.sendMessage({ type: 'vf:download', url: e.url, filename: ctx.fileBase + '.' + guessExt(e.url, 'mp4') });
          return { started: true };
        } });
    }

    // 5) Facebook / Instagram page data (single-video pages).
    if (!res.options.some((o) => o.type !== 'note')) {
      const prog = fbProgressive();
      prog.slice(0, 2).forEach((p, i) => add({ type: 'direct', label: p.hd ? 'HD with sound' : 'SD with sound',
        detail: 'From page data', match: i === 0 && prog.length <= 2 ? true : null,
        run: async () => {
          await chrome.runtime.sendMessage({ type: 'vf:download', url: p.url, filename: ctx.fileBase + '.mp4' });
          return { started: true };
        } }));
    }

    // Ranking: confirmed matches first.
    res.options.sort((a, b) => (b.match === true) - (a.match === true));
    return res;
  }

  function bytesProgress(ctx) {
    return (got, total) => ctx.onProgress(total ? got / total : null, VF.fmtBytes(got));
  }
  function guessExt(u, d) {
    const m = (u || '').split('?')[0].match(/\.(mp4|m4v|webm|mov|mkv|m4a|ts)$/i);
    return m ? m[1].toLowerCase() : d;
  }
  function shortName(u) {
    try { const p = new URL(u).pathname.split('/'); return decodeURIComponent(p[p.length - 1]).slice(0, 40); } catch (e) { return ''; }
  }
  VF.fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  VF.sources = { forVideo, probeRanged, durationMatch, fetchWithProgress };
})(globalThis);
