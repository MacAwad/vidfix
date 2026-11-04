const http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
const ROOT = __dirname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const orig = decodeURIComponent(u.pathname);
  let p = orig;
  if (p === '/hls.js') p = '/node_modules/hls.js/dist/hls.min.js';
  if (p.startsWith('/cdn/')) p = '/media/' + p.slice(5);          // fake CDN path
  if (p.startsWith('/p/')) p = '/pages/' + p.slice(3);            // test pages
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (orig.startsWith('/p/strict')) headers['Content-Security-Policy'] = "require-trusted-types-for 'script'; script-src 'self' 'unsafe-inline'";
  let start = 0, end = size - 1, partial = false;
  if (u.query.bytestart !== undefined) { start = +u.query.bytestart; end = Math.min(size - 1, +u.query.byteend); }
  else if (req.headers.range) { const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range); if (m) { start = m[1] ? +m[1] : 0; end = m[2] ? Math.min(size - 1, +m[2]) : size - 1; partial = true; } }
  headers['Content-Length'] = end - start + 1;
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}).listen(8800, () => console.log('lab server on 8800'));
