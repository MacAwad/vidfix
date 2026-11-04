/* VidFix - HLS (.m3u8) reader and downloader.
   Joins all segments into one file. If the stream keeps audio separate (common on X/Twitter),
   the audio is downloaded too and merged in, so you get one file with sound.
   Encrypted (protected) streams are refused on purpose. */
(function (g) {
  'use strict';
  const VF = g.VF || (g.VF = {});

  function attrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    return out;
  }
  const resolve = (u, base) => new URL(u, base).toString();

  async function getText(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  function parseMaster(text, base) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const variants = [], audios = {};
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (j < lines.length) {
          const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
          variants.push({ uri: resolve(lines[j], base), bandwidth: Number(a.BANDWIDTH) || 0,
            width: w || 0, height: h || 0, audio: a.AUDIO || null, codecs: a.CODECS || '' });
          i = j;
        }
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(l.slice(13));
        if (a.TYPE === 'AUDIO' && a['GROUP-ID']) {
          (audios[a['GROUP-ID']] = audios[a['GROUP-ID']] || []).push({
            uri: a.URI ? resolve(a.URI, base) : null, name: a.NAME || '', isDefault: a.DEFAULT === 'YES'
          });
        }
      }
    }
    variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
    return { variants, audios };
  }

  function parseRange(s, lastEnd) {
    const [len, off] = s.split('@');
    return { length: Number(len), offset: off !== undefined ? Number(off) : lastEnd };
  }

  function parseMedia(text, base) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const segs = [];
    let map = null, duration = 0, encrypted = false, live = true, nextDur = 0, range = null, lastEnd = 0;
    for (const l of lines) {
      if (l.startsWith('#EXTINF:')) nextDur = parseFloat(l.slice(8)) || 0;
      else if (l.startsWith('#EXT-X-KEY:')) {
        const a = attrs(l.slice(11));
        if (a.METHOD && a.METHOD !== 'NONE') encrypted = true;
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = attrs(l.slice(11));
        if (a.URI) map = { uri: resolve(a.URI, base), range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null };
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
        range = parseRange(l.slice(17), lastEnd);
      } else if (l.startsWith('#EXT-X-ENDLIST')) {
        live = false;
      } else if (l && !l.startsWith('#')) {
        segs.push({ uri: resolve(l, base), dur: nextDur, range });
        if (range) lastEnd = range.offset + range.length;
        duration += nextDur;
        nextDur = 0;
        range = null;
      }
    }
    return { segs, map, duration, encrypted, live };
  }

  // Look at an .m3u8 without downloading the video.
  async function inspect(url, signal) {
    const text = await getText(url, signal);
    if (text.includes('#EXT-X-STREAM-INF')) {
      const m = parseMaster(text, url);
      const best = m.variants[0];
      let media = null;
      if (best) {
        try { media = parseMedia(await getText(best.uri, signal), best.uri); } catch (e) { /* ignore */ }
      }
      return { url, master: m, media, duration: media ? media.duration : NaN,
        encrypted: media ? media.encrypted : false, live: media ? media.live : false };
    }
    const media = parseMedia(text, url);
    return { url, master: null, media, duration: media.duration, encrypted: media.encrypted, live: media.live };
  }

  async function fetchBytes(seg, signal) {
    const headers = seg.range ? { Range: `bytes=${seg.range.offset}-${seg.range.offset + seg.range.length - 1}` } : undefined;
    const r = await fetch(seg.uri, { headers, signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  async function fetchAll(media, signal, tick) {
    const list = media.map ? [media.map, ...media.segs] : media.segs.slice();
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        let tries = 0;
        for (;;) {
          try { out[i] = await fetchBytes(list[i], signal); break; } catch (e) {
            if (signal && signal.aborted) throw e;
            if (++tries >= 3) throw e;
            await new Promise((r) => setTimeout(r, 600 * tries));
          }
        }
        tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
    return { bytes: VF.mp4.concat(out), count: list.length };
  }

  // Download one HLS stream. variant = index into master.variants (0 = best).
  async function download(url, variant, onProgress, signal) {
    const info = await inspect(url, signal);
    let mediaUrl = url, audioUrl = null;
    if (info.master) {
      const v = info.master.variants[variant || 0];
      if (!v) throw new Error('No video found in this stream');
      mediaUrl = v.uri;
      if (v.audio && info.master.audios[v.audio]) {
        const group = info.master.audios[v.audio].filter((a) => a.uri);
        const a = group.find((x) => x.isDefault) || group[0];
        if (a) audioUrl = a.uri;
      }
    }
    const vm = parseMedia(await getText(mediaUrl, signal), mediaUrl);
    if (vm.encrypted) throw new Error('This stream is protected and cannot be saved.');
    if (vm.live) throw new Error('This is a live stream. Use "Record" instead.');
    const am = audioUrl ? parseMedia(await getText(audioUrl, signal), audioUrl) : null;
    if (am && am.encrypted) throw new Error('This stream is protected and cannot be saved.');
    const total = vm.segs.length + (vm.map ? 1 : 0) + (am ? am.segs.length + (am.map ? 1 : 0) : 0);
    let done = 0;
    const tick = () => onProgress && onProgress(++done / total);
    const v = await fetchAll(vm, signal, tick);
    const isTs = v.bytes[0] === 0x47;
    if (!am) return { parts: [v.bytes], ext: isTs ? 'ts' : 'mp4' };
    const a = await fetchAll(am, signal, tick);
    const audioIsTs = a.bytes[0] === 0x47;
    if (!isTs && !audioIsTs) {
      try { return { parts: VF.mp4.merge(v.bytes, a.bytes), ext: 'mp4' }; } catch (e) { /* fall through */ }
    }
    return { parts: [v.bytes], ext: isTs ? 'ts' : 'mp4', extra: { parts: [a.bytes], ext: audioIsTs ? 'ts' : 'm4a', label: 'audio' } };
  }

  VF.hls = { inspect, download, parseMaster, parseMedia };
})(globalThis);
