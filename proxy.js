// FileSwap download server for Railway: serves the download page at /CODE and streams Gofile files.
// The upload dashboard (index.html) stays offline on your own machine.
// Env (all optional): GOFILE_WT_SALT = salt(s) for Gofile's website token, comma separated. PORT is set by Railway.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GOFILE_API = 'https://api.gofile.io';
const PORT = process.env.PORT || 3000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIRS = [HERE, path.join(HERE, 'public')];   // download.html next to this file, or in ./public

/* ---------- tuning ---------- */
const TOKEN_TTL = 2 * 60 * 60 * 1000;   // reuse one Gofile guest account
const FILE_TTL = 5 * 60 * 1000;         // a lookup is reused for info + download
const STALE_TTL = 60 * 60 * 1000;       // while Gofile is throttling us, serve lookups up to 1h old
const MISS_TTL = 60 * 1000;             // remember "not found" so random codes don't hit Gofile
const LIMIT_INFO = 40;                  // per visitor per minute
const LIMIT_DL = 8;                     // download starts per visitor per minute
const MAX_DL_PER_IP = 3;                // parallel downloads per visitor
const MAX_DL_TOTAL = 25;                // parallel downloads for the whole server

/* ---------- Gofile website token ---------- */
// X-Website-Token = sha256(UA::lang::accountToken::floor(unix/14400)::salt). Gofile rotates the salt now and then:
// set GOFILE_WT_SALT when that happens; a few known values are tried automatically.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LANG = 'en-US';
const SALTS = [
  ...(process.env.GOFILE_WT_SALT || '').split(',').map(s => s.trim()).filter(Boolean),
  '5d4f7g8sd45fsd', '12af056dacea0b', '9844d94d963d30',
];
let goodSalt = '';
const makeWt = (token, salt) =>
  createHash('sha256').update(`${UA}::${LANG}::${token}::${Math.floor(Date.now() / 1000 / 14400)}::${salt}`).digest('hex');

/* ---------- Gofile rate-limit handling ---------- */
let blockedUntil = 0;                   // set when Gofile throttles us; we stop calling it until then
class Busy extends Error { constructor(wait) { super('busy'); this.wait = wait; } }
function cooldown(r) {
  const wait = Math.min(Number(r.headers.get('retry-after')) || 30, 300);
  blockedUntil = Date.now() + wait * 1000;
  return new Busy(wait);
}

let cachedToken = '', cachedAt = 0;
async function getToken(force = false) {
  if (!force && cachedToken && Date.now() - cachedAt < TOKEN_TTL) return cachedToken;
  const r = await fetch(`${GOFILE_API}/accounts`, { method: 'POST', headers: { 'User-Agent': UA, 'X-BL': LANG }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) throw cooldown(r);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'ok' || !j.data?.token) throw new Error(`account request failed (${r.status} ${j.status || ''})`);
  cachedToken = j.data.token; cachedAt = Date.now();
  return cachedToken;
}

const validCode = c => /^(?=.{3,64}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(c);

async function findFile(code) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 1);
    const salts = goodSalt ? [goodSalt, ...SALTS.filter(s => s !== goodSalt)] : SALTS;
    for (const salt of salts) {
      const r = await fetch(`${GOFILE_API}/contents/${encodeURIComponent(code)}`, {
        headers: { Authorization: `Bearer ${token}`, Cookie: `accountToken=${token}`, 'User-Agent': UA, 'X-BL': LANG, 'X-Website-Token': makeWt(token, salt) },
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      last = `${r.status} ${j.status || ''}`.trim();
      if (j.status === 'ok') {
        goodSalt = salt;
        const d = j.data;
        const file = d?.type === 'file' ? d : Object.values(d?.children || {}).find(c => c?.type === 'file');
        if (!file?.link) return null;
        const u = new URL(file.link);
        if (u.protocol !== 'https:' || !(u.hostname === 'gofile.io' || u.hostname.endsWith('.gofile.io'))) throw new Error('unexpected download host');
        return { file, token };
      }
      if (j.status === 'error-notFound') return null;
      if (j.status === 'error-notPremium') continue;      // wrong salt, try the next one
      if (j.status === 'error-rateLimit' || r.status === 429) throw cooldown(r);
      break;                                              // other error: fresh token, retry once
    }
  }
  throw new Error(`lookup failed (${last}). If this is error-notPremium, the Gofile salt changed: set GOFILE_WT_SALT`);
}

const fileCache = new Map(), misses = new Map(), inflight = new Map();
async function getFile(code) {
  const now = Date.now();
  const c = fileCache.get(code);
  if (c && now - c.at < FILE_TTL) return c.hit;
  const miss = misses.get(code);
  if (miss && now - miss < MISS_TTL) return null;
  const stale = c && now - c.at < STALE_TTL ? c.hit : null;
  if (stale && now < blockedUntil) return stale;            // Gofile is throttling: serve what we know
  if (inflight.has(code)) return inflight.get(code);        // share one lookup between simultaneous visitors
  const p = (async () => {
    if (now < blockedUntil) throw new Busy(Math.ceil((blockedUntil - now) / 1000));
    try {
      const hit = await findFile(code);
      if (hit) {
        if (fileCache.size > 500) fileCache.delete(fileCache.keys().next().value);
        fileCache.set(code, { at: Date.now(), hit });
      } else {
        if (misses.size > 2000) misses.clear();
        misses.set(code, Date.now()); fileCache.delete(code);
      }
      return hit;
    } catch (e) {
      if (e instanceof Busy && stale) return stale;
      throw e;
    }
  })().finally(() => inflight.delete(code));
  inflight.set(code, p);
  return p;
}

/* ---------- visitor limits ---------- */
const hits = new Map(), active = new Map();
let activeTotal = 0;
function limited(key, max, windowMs = 60000) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > max ? Math.ceil((h.reset - now) / 1000) : 0;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60000).unref();
// Railway puts the visitor first in X-Forwarded-For (a faker can dodge the per-visitor limit, but not the global ones)
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

/* ---------- responses ---------- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SEC, ...extra });
  res.end(body);
}
function errorPage(res, status, title, msg) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · FileSwap</title>
<style>*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;padding:20px;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f8f7;color:#1b2a25}
.c{background:#fff;border:1px solid #e2e8e5;border-radius:16px;padding:32px 28px;width:min(400px,100%);text-align:center;box-shadow:0 8px 28px rgba(20,40,32,.08)}
.n{font-size:44px;font-weight:700;color:#0a8f67;line-height:1}h1{font-size:18px;margin:12px 0 6px}p{color:#6b7c76;line-height:1.5}</style></head>
<body><div class="c"><div class="n">${status}</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
  send(res, status, html, 'text/html; charset=utf-8');
}
async function readPage() {
  for (const dir of PAGE_DIRS) { try { return await readFile(path.join(dir, 'download.html')); } catch {} }
  throw new Error('download.html not found');
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;
  const isApi = route === '/api/info' || route === '/api/dl';

  // Download page: /CODE (also /d/CODE and the old /download.html#CODE)
  const m = route.match(/^\/(?:d\/)?([A-Za-z0-9-]{3,64})\/?$/);
  const isPage = route === '/download.html' || (m && !['api', 'health', 'download'].includes(m[1]));
  if (isPage) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return errorPage(res, 405, 'Not allowed', 'This page only supports viewing.');
    try { return send(res, 200, await readPage(), 'text/html; charset=utf-8'); }
    catch { return errorPage(res, 500, 'Something broke', 'The download page is missing on the server.'); }
  }
  if (route === '/health') return send(res, 200, 'ok');
  if (route === '/') return errorPage(res, 200, 'FileSwap', 'Temporary file sharing. Open a share link to download a file.');
  if (!isApi) return errorPage(res, 404, 'Page not found', 'This link does not exist. Check that you copied the whole share link.');
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');

  const ip = clientIp(req);
  const wait = limited('i:' + ip, LIMIT_INFO) || (route === '/api/dl' ? limited('d:' + ip, LIMIT_DL) : 0);
  if (wait) return send(res, 429, `Too many requests, try again in ${wait} seconds`, 'text/plain; charset=utf-8', { 'Retry-After': String(wait) });

  const code = url.searchParams.get('code') || '';
  if (!validCode(code)) return send(res, 400, 'Invalid file code');

  const ac = new AbortController();
  res.on('close', () => ac.abort());   // stop the upstream download if the visitor cancels

  try {
    const hit = await getFile(code);
    if (!hit) return send(res, 404, 'File not found or expired');
    const { file, token } = hit;

    if (route === '/api/info') {
      return send(res, 200, JSON.stringify({ name: file.name, size: Number(file.size) || 0 }), 'application/json; charset=utf-8');
    }

    if (activeTotal >= MAX_DL_TOTAL || (active.get(ip) || 0) >= MAX_DL_PER_IP) {
      return send(res, 429, 'Too many downloads running, try again shortly', 'text/plain; charset=utf-8', { 'Retry-After': '15' });
    }
    activeTotal++; active.set(ip, (active.get(ip) || 0) + 1);
    res.on('close', () => { activeTotal--; const n = (active.get(ip) || 1) - 1; n ? active.set(ip, n) : active.delete(ip); });

    const h = { Authorization: `Bearer ${token}`, Cookie: `accountToken=${token}`, 'User-Agent': UA, Referer: 'https://gofile.io/' };
    for (const k of ['range', 'if-range']) if (req.headers[k]) h[k] = req.headers[k];
    const up = await fetch(file.link, { headers: h, signal: ac.signal });
    if (!up.ok && up.status !== 206) {
      fileCache.delete(code);            // link may have expired, look it up again next time
      return send(res, 502, `Gofile download failed (${up.status})`);
    }

    const out = {
      'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name || 'download')}`,
      'Accept-Ranges': up.headers.get('accept-ranges') || 'bytes',
      ...SEC,
    };
    for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) {
      const v = up.headers.get(k); if (v) out[k] = v;
    }
    res.writeHead(up.status, out);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (e instanceof Busy) return send(res, 429, `Busy, try again in ${e.wait} seconds`, 'text/plain; charset=utf-8', { 'Retry-After': String(e.wait) });
    console.error('proxy error:', e.message, e.cause?.code || e.cause?.message || '');
    if (!res.headersSent) send(res, 502, 'Download service request failed'); else res.destroy();
  }
});

server.listen(PORT, () => console.log(`FileSwap on :${PORT}`));

// Railway sends SIGTERM when it replaces the container on a redeploy: exit cleanly so npm doesn't log an error
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
});
