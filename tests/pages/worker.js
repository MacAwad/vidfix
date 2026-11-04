// Dedicated worker that runs MSE (like newer Facebook / Instagram players).
const ms = new MediaSource();
postMessage({ handle: ms.handle }, [ms.handle]);
const app = (sb, d) => new Promise(r => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(d); });
const get = async (u) => new Uint8Array(await (await fetch(u + '&bytestart=0&byteend=99999999')).arrayBuffer());
ms.addEventListener('sourceopen', async () => {
  const vb = ms.addSourceBuffer('video/mp4; codecs="avc1.42c01e"'), ab = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  await app(vb, await get('/cdn/fb_video.mp4?x=1'));
  await app(ab, await get('/cdn/fb_audio.mp4?x=1'));
  ms.endOfStream();
  postMessage({ ready: true });
});
