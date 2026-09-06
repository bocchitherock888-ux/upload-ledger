/** Local-only development server. No third-party packages and no file persistence. */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const portIndex = process.argv.indexOf('--port');
const port = portIndex < 0 ? 8765 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Choose a port between 1024 and 65535.'); process.exit(2);
}
const origin = `http://127.0.0.1:${port}`;
const maxBytes = 60 * 1024 * 1024;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const commonHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' http://127.0.0.1:8765 http://127.0.0.1:8766; object-src 'none'; base-uri 'none'; form-action 'self'",
};
function json(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHosts.has(req.headers.host || '')) return json(res, 403, { error: 'HOST_REJECTED' });
    const requestedOrigin = `http://${req.headers.host}`;
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== requestedOrigin) {
      return json(res, 403, { error: 'ORIGIN_REJECTED' });
    }
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rawPath.includes('\\') || rawPath.includes('\0') || rawPath.split('/').includes('..')) {
      return json(res, 400, { error: 'PATH_REJECTED' });
    }
    const path = new URL(req.url || '/', origin).pathname;
    if (req.method === 'POST' && ['/upload', '/fail', '/form'].includes(path)) {
      const declared = req.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        req.resume(); return json(res, 413, { error: 'BODY_LIMIT' });
      }
      let bytes = 0;
      const hash = createHash('sha256');
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes) { json(res, 413, { error: 'BODY_LIMIT' }); req.destroy(); return; }
        hash.update(chunk);
      }
      return json(res, path === '/fail' ? 500 : 200, {
        received: true, byteLength: bytes, sha256: hash.digest('hex'),
        digestScope: path === '/form' ? 'entire-multipart-request-body' : 'raw-request-body',
        simulatedFailure: path === '/fail',
      });
    }
    if (!['GET', 'HEAD'].includes(req.method || '')) return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (path === '/health') return json(res, 200, { ok: true, purpose: 'upload-ledger-local-testkit' });
    let file;
    let fixture = false;
    if (path.startsWith('/fixtures/')) {
      fixture = true;
      const base = resolve(root, 'fixtures');
      file = resolve(base, decodeURIComponent(path.slice('/fixtures/'.length)));
      if (!file.startsWith(base + sep)) return json(res, 400, { error: 'PATH_REJECTED' });
    } else {
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!['index.html', 'site.js', 'style.css', 'frame.html', 'done.html'].includes(name)) {
        return json(res, 404, { error: 'NOT_FOUND' });
      }
      file = resolve(root, 'site', name);
    }
    const info = await stat(file);
    if (!info.isFile()) return json(res, 404, { error: 'NOT_FOUND' });
    const headers = { ...commonHeaders, 'Content-Length': info.size,
      'Content-Type': fixture ? 'application/octet-stream' : (MIME[extname(file)] || 'application/octet-stream') };
    if (fixture) headers['Content-Disposition'] = 'attachment';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    json(res, error?.code === 'ENOENT' ? 404 : 400, { error: 'REQUEST_REJECTED' });
  }
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.on('error', error => { console.error(`Server error: ${error.code || 'UNKNOWN'}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Upload Ledger testkit: ${origin}/`);
  console.log('Use synthetic fixtures only. No uploaded bytes are saved. Stop with Ctrl+C.');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
