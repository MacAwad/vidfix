/* VidFix - small MP4 (ISO-BMFF) toolkit.
   - parse(): read tracks, duration and protection flags.
   - merge(): join a video-only and an audio-only fragmented MP4 into ONE file with sound,
     without re-encoding (the same idea as "ffmpeg -c copy", done in the browser). */
(function (g) {
  'use strict';
  const VF = g.VF || (g.VF = {});

  const t4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u64 = (dv, o) => dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);

  function readBoxes(u8, start, end) {
    const dv = dvOf(u8);
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = u64(dv, p + 8);
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr) break;
      const box = { type: t4(u8, p + 4), start: p, size, hdr, end: p + size, truncated: p + size > end };
      out.push(box);
      if (box.truncated) break;
      p += size;
    }
    return out;
  }
  const kids = (u8, b) => readBoxes(u8, b.start + b.hdr, Math.min(b.end, u8.length));
  const child = (u8, b, t) => (b ? kids(u8, b).find((x) => x.type === t) : undefined);
  const path = (u8, b, types) => types.reduce((cur, t) => child(u8, cur, t), b);

  function parse(u8) {
    const dv = dvOf(u8);
    const top = readBoxes(u8, 0, u8.length);
    const res = { top, tracks: [], fragmented: false, encrypted: false, duration: 0, bestDuration: 0 };
    res.ftyp = top.find((b) => b.type === 'ftyp');
    res.moov = top.find((b) => b.type === 'moov' && !b.truncated);
    const sidx = top.find((b) => b.type === 'sidx' && !b.truncated);
    if (sidx) res.sidxDuration = sidxDuration(u8, dv, sidx);
    if (!res.moov) return res;
    const mk = kids(u8, res.moov);
    res.mvhd = mk.find((b) => b.type === 'mvhd');
    res.mvex = mk.find((b) => b.type === 'mvex');
    res.fragmented = !!res.mvex;
    if (mk.some((b) => b.type === 'pssh')) res.encrypted = true;
    if (res.mvhd) {
      const o = res.mvhd.start + res.mvhd.hdr, v = u8[o];
      const ts = dv.getUint32(o + (v ? 20 : 12));
      const d = v ? u64(dv, o + 24) : dv.getUint32(o + 16);
      res.movieTimescale = ts;
      if (ts && d && d !== 0xffffffff) res.duration = d / ts;
    }
    for (const trak of mk.filter((b) => b.type === 'trak')) {
      const tkhd = child(u8, trak, 'tkhd');
      const mdia = child(u8, trak, 'mdia');
      const mdhd = child(u8, mdia, 'mdhd');
      const hdlr = child(u8, mdia, 'hdlr');
      const stsd = path(u8, mdia, ['minf', 'stbl', 'stsd']);
      if (!tkhd || !mdhd || !hdlr) continue;
      const to = tkhd.start + tkhd.hdr, tv = u8[to];
      const idOff = to + (tv ? 20 : 12);
      const mo = mdhd.start + mdhd.hdr, mv = u8[mo];
      const timescale = dv.getUint32(mo + (mv ? 20 : 12));
      const md = mv ? u64(dv, mo + 24) : dv.getUint32(mo + 16);
      let codec = '';
      if (stsd) {
        const e = stsd.start + stsd.hdr + 8;
        if (e + 8 <= stsd.end) codec = t4(u8, e + 4);
      }
      if (codec === 'encv' || codec === 'enca') res.encrypted = true;
      const wOff = to + (tv ? 88 : 76);
      const width = wOff + 8 <= tkhd.end ? dv.getUint32(wOff) / 65536 : 0;
      const height = wOff + 8 <= tkhd.end ? dv.getUint32(wOff + 4) / 65536 : 0;
      res.tracks.push({
        trak, idOff, id: dv.getUint32(idOff), timescale,
        duration: timescale && md && md !== 0xffffffff ? md / timescale : 0,
        handler: t4(u8, hdlr.start + hdlr.hdr + 8), codec, width, height
      });
    }
    if (res.mvex && res.movieTimescale) {
      const mehd = child(u8, res.mvex, 'mehd');
      if (mehd) {
        const o = mehd.start + mehd.hdr, v = u8[o];
        const d = v ? u64(dv, o + 4) : dv.getUint32(o + 4);
        if (d) res.mehdDuration = d / res.movieTimescale;
      }
    }
    res.bestDuration = res.sidxDuration || res.mehdDuration ||
      Math.max(res.duration, 0, ...res.tracks.map((t) => t.duration));
    return res;
  }

  function sidxDuration(u8, dv, b) {
    const o = b.start + b.hdr, v = u8[o];
    const ts = dv.getUint32(o + 8);
    let p = o + 12 + (v ? 16 : 8) + 2;
    const count = dv.getUint16(p);
    p += 2;
    let sum = 0;
    for (let i = 0; i < count && p + 12 <= b.end; i++, p += 12) sum += dv.getUint32(p + 4);
    return ts ? sum / ts : 0;
  }

  function makeBox(type, parts) {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    const dv = dvOf(out);
    dv.setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let p = 8;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
  }

  function copyWithU32(u8, box, relOffset, value) {
    const c = u8.slice(box.start, box.end);
    dvOf(c).setUint32(relOffset, value);
    return c;
  }

  // Decode time (seconds) of a fragment, used to interleave audio and video.
  function fragTime(u8, moof, timescale) {
    const traf = child(u8, moof, 'traf');
    const tfdt = child(u8, traf, 'tfdt');
    if (!tfdt) return NaN;
    const o = tfdt.start + tfdt.hdr, v = u8[o];
    const dv = dvOf(u8);
    const t = v ? u64(dv, o + 4) : dv.getUint32(o + 4);
    return timescale ? t / timescale : NaN;
  }

  function merge(vU8, aU8) {
    const V = parse(vU8), A = parse(aU8);
    if (!V.moov || !A.moov) throw new Error('Not an MP4 file');
    if (V.encrypted || A.encrypted) throw new Error('This stream is protected');
    if (!V.fragmented || !A.fragmented) throw new Error('Not a fragmented MP4');
    const vt = V.tracks.find((t) => t.handler === 'vide');
    const at = A.tracks.find((t) => t.handler === 'soun');
    if (!vt || !at) throw new Error('Could not find both a video and an audio track');
    const inputs = [
      { u8: vU8, P: V, tr: vt, newId: 1 },
      { u8: aU8, P: A, tr: at, newId: 2 }
    ];

    // moov = mvhd + video trak + audio trak + mvex(trex, trex)
    const mvhd = vU8.slice(V.mvhd.start, V.mvhd.end);
    {
      const o = V.mvhd.hdr, ver = mvhd[o];
      dvOf(mvhd).setUint32(o + (ver ? 108 : 96), 3); // next_track_ID
    }
    const trakCopy = (inp) => copyWithU32(inp.u8, inp.tr.trak, inp.tr.idOff - inp.tr.trak.start, inp.newId);
    const trexCopy = (inp) => {
      const trex = kids(inp.u8, inp.P.mvex).find((b) => b.type === 'trex' &&
        dvOf(inp.u8).getUint32(b.start + b.hdr + 4) === inp.tr.id);
      if (!trex) throw new Error('Missing trex');
      return copyWithU32(inp.u8, trex, trex.hdr + 4, inp.newId);
    };
    const moov = makeBox('moov', [mvhd, trakCopy(inputs[0]), trakCopy(inputs[1]),
      makeBox('mvex', [trexCopy(inputs[0]), trexCopy(inputs[1])])]);
    const ftyp = V.ftyp ? vU8.subarray(V.ftyp.start, V.ftyp.end)
      : makeBox('ftyp', [new TextEncoder().encode('isom'), new Uint8Array(4), new TextEncoder().encode('isomiso6mp41')]);

    // Collect fragments (moof + following mdat boxes). sidx / styp / mfra are dropped.
    const frags = [];
    for (const inp of inputs) {
      let cur = null, idx = 0;
      for (const b of inp.P.top) {
        if (b.truncated) break;
        if (b.type === 'moof') {
          cur = { inp, moof: b, data: [], idx: idx++, time: fragTime(inp.u8, b, inp.tr.timescale) };
          frags.push(cur);
        } else if (b.type === 'mdat' && cur) {
          cur.data.push(b);
        }
      }
    }
    if (!frags.length) throw new Error('No media fragments found');
    const allTimed = frags.every((f) => isFinite(f.time));
    frags.sort((a, b) => (allTimed ? a.time - b.time : 0) || a.inp.newId - b.inp.newId || a.idx - b.idx);
    if (!allTimed) frags.sort((a, b) => a.idx - b.idx || a.inp.newId - b.inp.newId);

    const out = [ftyp, moov];
    let pos = ftyp.length + moov.length;
    let seq = 1;
    for (const f of frags) {
      const moofCopy = f.inp.u8.slice(f.moof.start, f.moof.end);
      patchMoof(moofCopy, f.inp, seq++, pos, f.moof.start);
      out.push(moofCopy);
      pos += moofCopy.length;
      for (const d of f.data) { out.push(f.inp.u8.subarray(d.start, d.end)); pos += d.size; }
    }
    return out;
  }

  function patchMoof(m, inp, seq, newPos, oldPos) {
    const dv = dvOf(m);
    const moof = readBoxes(m, 0, m.length)[0];
    for (const b of kids(m, moof)) {
      if (b.type === 'mfhd') dv.setUint32(b.start + b.hdr + 4, seq);
      if (b.type !== 'traf') continue;
      const tfhd = child(m, b, 'tfhd');
      if (!tfhd) continue;
      const o = tfhd.start + tfhd.hdr;
      const flags = (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3];
      dv.setUint32(o + 4, inp.newId);
      if (flags & 1) {
        const oldBase = u64(dv, o + 8);
        const nb = oldBase - oldPos + newPos;
        dv.setUint32(o + 8, Math.floor(nb / 4294967296));
        dv.setUint32(o + 12, nb >>> 0);
      }
    }
  }

  function concat(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  VF.mp4 = { parse, merge, concat, readBoxes };
})(globalThis);
