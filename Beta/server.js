// FileSwap server for Railway: serves the pages, takes uploads, and streams downloads.
// Browsers only ever talk to this server; Gofile is hidden behind /api/*.
//
// Env vars:
//   ID_SECRET        (required for uploads) long random string; makes share links opaque. Never change it or old links break.
//   GOFILE_TOKEN     (recommended) token of a free Gofile account, so every upload lives under one stable account
//   ADMIN_KEY        (optional) lets you delete any file: POST /api/delete {"id":"...","admin":"<ADMIN_KEY>"}
//   GOFILE_WT_SALT   (optional) Gofile website-token salt(s), comma separated, if Gofile rotates it
//   MAX_UPLOAD_MB    (default 100)   DAILY_UPLOAD_MB (default 300, per visitor)
//   BLOCKED_EXT      (default exe,msi,bat,cmd,scr,com,pif,vbs,ps1,dll; "none" allows everything)
//   LEGACY_LINKS     set "true" to keep serving old links that contain a raw Gofile code
import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GOFILE_API = 'https://api.gofile.io';
const PORT = process.env.PORT || 3000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIRS = [HERE, path.join(HERE, 'public')];   // html files next to this file, or in ./public

/* ---------- settings ---------- */
const SECRET = process.env.ID_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const LEGACY = process.env.LEGACY_LINKS === 'true' || !SECRET;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 100;
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
const DAILY_BYTES = (Number(process.env.DAILY_UPLOAD_MB) || 300) * 1024 * 1024;
const BLOCKED = new Set((process.env.BLOCKED_EXT ?? 'exe,msi,bat,cmd,scr,com,pif,vbs,ps1,dll')
  .split(',').map(s => s.trim().toLowerCase()).filter(s => s && s !== 'none'));

const TOKEN_TTL = 2 * 60 * 60 * 1000;   // reuse one Gofile guest account for lookups
const FILE_TTL = 5 * 60 * 1000;         // a lookup is reused for info + download
const STALE_TTL = 60 * 60 * 1000;       // while Gofile throttles us, serve lookups up to 1h old
const MISS_TTL = 60 * 1000;             // remember "not found"
const LIMIT_INFO = 30;                  // info requests per visitor per minute
const LIMIT_DL = 6;                     // download starts per visitor per minute
const LIMIT_UPLOADS = 5;                // uploads per visitor per 10 minutes
const LIMIT_DELETE = 15;                // deletes per visitor per minute
const MAX_DL_PER_IP = 2, MAX_DL_TOTAL = 20;
const MAX_UP_PER_IP = 2, MAX_UP_TOTAL = 6;

/* ---------- opaque share ids (stateless) ---------- */
// id = base64url(iv + AES-256-GCM(gofileCode) + tag). key = HMAC(code), given only to the uploader for deleting.
const KEY32 = SECRET ? createHash('sha256').update('id:' + SECRET).digest() : null;
const RAW = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const sign = code => createHmac('sha256', SECRET).update('key:' + code).digest('hex').slice(0, 32);
function encId(code) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', KEY32, iv);
  return Buffer.concat([iv, c.update(code, 'utf8'), c.final(), c.getAuthTag()]).toString('base64url');
}
function decId(id) {
  if (KEY32 && id.length >= 24) {
    try {
      const b = Buffer.from(id, 'base64url');
      if (b.length >= 29) {
        const d = createDecipheriv('aes-256-gcm', KEY32, b.subarray(0, 12));
        d.setAuthTag(b.subarray(b.length - 16));
        const code = Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
        if (RAW.test(code) && code.length <= 64) return code;
      }
    } catch {}
  }
  return LEGACY && id.length <= 64 && RAW.test(id) ? id : null;
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/* ---------- Gofile website token ---------- */
// X-Website-Token = sha256(UA::lang::accountToken::floor(unix/14400)::salt). Gofile rotates the salt now and then.
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
let blockedUntil = 0;
class Busy extends Error { constructor(wait) { super('busy'); this.wait = wait; } }
function cooldown(r) {
  const wait = Math.min(Number(r.headers.get('retry-after')) || 30, 300);
  blockedUntil = Date.now() + wait * 1000;
  return new Busy(wait);
}
async function newGuest() {
  const r = await fetch(`${GOFILE_API}/accounts`, { method: 'POST', headers: { 'User-Agent': UA, 'X-BL': LANG }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) throw cooldown(r);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'ok' || !j.data?.token) throw new Error(`account request failed (${r.status} ${j.status || ''})`);
  return j.data.token;
}
let cachedToken = '', cachedAt = 0;
async function getToken(force = false) {
  if (!force && cachedToken && Date.now() - cachedAt < TOKEN_TTL) return cachedToken;
  cachedToken = await newGuest(); cachedAt = Date.now();
  return cachedToken;
}
let upToken = process.env.GOFILE_TOKEN || '';          // stable account that owns every upload
const uploadToken = async () => upToken || (upToken = await newGuest());

/* ---------- lookups (cached) ---------- */
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
      break;
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
  if (stale && now < blockedUntil) return stale;
  if (inflight.has(code)) return inflight.get(code);
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
const hits = new Map(), active = new Map(), upByIp = new Map(), daily = new Map();
let activeTotal = 0, upTotal = 0;
function limited(key, max, windowMs = 60000) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > max ? Math.ceil((h.reset - now) / 1000) : 0;
}
function useQuota(ip, bytes) {
  const now = Date.now();
  let d = daily.get(ip);
  if (!d || now > d.reset) { d = { bytes: 0, reset: now + 86400000 }; daily.set(ip, d); }
  if (d.bytes + bytes > DAILY_BYTES) return false;
  d.bytes += bytes; return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
  for (const [k, d] of daily) if (now > d.reset) daily.delete(k);
}, 60000).unref();
// Railway puts the visitor first in X-Forwarded-For (faking it dodges the per-visitor limit, never the global ones)
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
const bump = (map, key, d) => { const n = (map.get(key) || 0) + d; n > 0 ? map.set(key, n) : map.delete(key); };

/* ---------- responses ---------- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SEC, ...extra });
  res.end(body);
}
const json = (res, status, obj, extra = {}) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
function errorPage(res, status, title, msg) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · FileSwap</title>
<style>*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;padding:20px;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f8f7;color:#1b2a25}
.c{background:#fff;border:1px solid #e2e8e5;border-radius:16px;padding:32px 28px;width:min(400px,100%);text-align:center;box-shadow:0 8px 28px rgba(20,40,32,.08)}
.n{font-size:44px;font-weight:700;color:#0a8f67;line-height:1}h1{font-size:18px;margin:12px 0 6px}p{color:#6b7c76;line-height:1.5}</style></head>
<body><div class="c"><div class="n">${status}</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
  send(res, status, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP });
}
async function readPage(name) {
  for (const dir of PAGE_DIRS) { try { return await readFile(path.join(dir, name)); } catch {} }
  throw new Error(name + ' not found');
}
async function readJson(req, max = 2048) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > max) throw new Error('too big'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

/* ---------- upload: browser -> this server -> Gofile ---------- */
const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, '_').trim().slice(0, 150);
async function pickServer() {
  try {
    const r = await fetch(`${GOFILE_API}/servers`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const name = j?.data?.servers?.[0]?.name;
    if (j.status === 'ok' && /^[a-z0-9-]+$/.test(name || '')) return name;
  } catch {}
  return 'upload';
}

async function handleUpload(req, res, ip, url) {
  const fail = (status, error, extra) => {
    res.setHeader('Connection', 'close');
    json(res, status, { error }, extra);
    res.on('finish', () => req.destroy());
  };
  if (!KEY32) return fail(503, 'Uploads are not enabled on this server');
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const size = Number(req.headers['content-length']);
  if (!Number.isFinite(size) || size <= 0) return fail(411, 'Empty file or unknown size');
  if (size > MAX_UPLOAD) return fail(413, `File too large (max ${MAX_UPLOAD_MB} MB)`);
  const name = cleanName(url.searchParams.get('name'));
  if (!name) return fail(400, 'Missing file name');
  if (BLOCKED.has((name.split('.').pop() || '').toLowerCase())) return fail(415, 'This file type is not allowed');
  const wait = limited('u:' + ip, LIMIT_UPLOADS, 600000);
  if (wait) return fail(429, `Upload limit reached, try again in ${Math.ceil(wait / 60)} min`, { 'Retry-After': String(wait) });
  if (!useQuota(ip, size)) return fail(429, 'Daily upload limit reached, try again tomorrow');
  if (upTotal >= MAX_UP_TOTAL || (upByIp.get(ip) || 0) >= MAX_UP_PER_IP) return fail(429, 'Server is busy with other uploads, try again shortly', { 'Retry-After': '20' });

  upTotal++; bump(upByIp, ip, 1);
  let released = false;
  const release = () => { if (!released) { released = true; upTotal--; bump(upByIp, ip, -1); } };
  res.on('close', release);

  let token, srv;
  try { [token, srv] = [await uploadToken(), await pickServer()]; }
  catch (e) { return e instanceof Busy ? fail(429, `Busy, try again in ${e.wait} seconds`, { 'Retry-After': String(e.wait) }) : fail(502, 'Storage service unavailable, try again'); }

  const b = '----fileswap' + randomBytes(12).toString('hex');
  const pre = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const post = Buffer.from(`\r\n--${b}--\r\n`);
  const up = https.request({
    hostname: `${srv}.gofile.io`, path: '/contents/uploadfile', method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': pre.length + size + post.length, 'User-Agent': UA },
  }, resp => {
    const chunks = [];
    resp.on('data', c => chunks.push(c));
    resp.on('end', () => {
      if (res.writableEnded) return;
      let j = {}; try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
      const code = j.data?.parentFolderCode || (j.data?.downloadPage || '').split('/').filter(Boolean).pop();
      if (j.status === 'ok' && code && RAW.test(code)) {
        fileCache.delete(code); misses.delete(code);
        return json(res, 200, { id: encId(code), key: sign(code), name, size });
      }
      if (resp.statusCode === 429 || j.status === 'error-rateLimit') return json(res, 429, { error: 'Storage is busy, try again in a minute' }, { 'Retry-After': '60' });
      console.error('upload rejected:', resp.statusCode, j.status || '');
      json(res, 502, { error: 'Storage service rejected the upload' });
    });
  });
  up.setTimeout(120000, () => up.destroy(new Error('timeout')));
  up.on('error', e => {
    console.error('upload error:', e.message);
    if (!res.headersSent) json(res, 502, { error: 'Storage service unavailable, try again' });
    req.destroy();
  });
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });

  let received = 0;
  up.write(pre);
  req.on('data', chunk => {
    received += chunk.length;
    if (received > size) { up.destroy(); return req.destroy(); }
    if (!up.write(chunk)) { req.pause(); up.once('drain', () => req.resume()); }
  });
  req.on('end', () => { if (received === size) up.end(post); else up.destroy(); });
}

async function handleDelete(req, res, ip) {
  if (!KEY32) return json(res, 503, { error: 'Not enabled' });
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const wait = limited('x:' + ip, LIMIT_DELETE);
  if (wait) return json(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(wait) });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad request' }); }
  const code = decId(String(body.id || ''));
  const isAdmin = ADMIN_KEY && body.admin && same(body.admin, ADMIN_KEY);
  if (!code || !(isAdmin || (body.key && same(sign(code), body.key)))) return json(res, 403, { error: 'Not allowed' });
  try {
    const hit = await getFile(code);
    if (!hit) return json(res, 404, { error: 'Already gone' });
    const contentsId = hit.file.parentFolder || hit.file.id;
    const token = await uploadToken();
    const r = await fetch(`${GOFILE_API}/contents`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ contentsId }), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (j.status !== 'ok') { console.error('delete refused:', r.status, j.status || ''); return json(res, 502, { error: 'Storage refused the delete' }); }
    fileCache.delete(code); misses.set(code, Date.now());
    json(res, 200, { ok: true });
  } catch (e) {
    if (e instanceof Busy) return json(res, 429, { error: `Busy, try again in ${e.wait} seconds` }, { 'Retry-After': String(e.wait) });
    console.error('delete error:', e.message);
    json(res, 502, { error: 'Delete failed, try again' });
  }
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;
  const ip = clientIp(req);

  if (route === '/api/upload') return handleUpload(req, res, ip, url);
  if (route === '/api/delete') return handleDelete(req, res, ip);

  const isApi = route === '/api/info' || route === '/api/dl';

  // Pages: / (upload dashboard), /ID (download page), also /d/ID and the old /download.html#ID
  const m = route.match(/^\/(?:d\/)?([A-Za-z0-9_-]{3,128})\/?$/);
  const reserved = ['api', 'health', 'download', 'index'];
  const page = route === '/' || route === '/index.html' ? 'index.html'
    : (route === '/download.html' || (m && !reserved.includes(m[1]))) ? 'download.html' : null;
  if (page) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return errorPage(res, 405, 'Not allowed', 'This page only supports viewing.');
    try { return send(res, 200, await readPage(page), 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP }); }
    catch { return errorPage(res, 500, 'Something broke', 'This page is missing on the server.'); }
  }
  if (route === '/health') return send(res, 200, 'ok');
  if (!isApi) return errorPage(res, 404, 'Page not found', 'This link does not exist. Check that you copied the whole share link.');
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');

  const wait = limited('i:' + ip, LIMIT_INFO) || (route === '/api/dl' ? limited('d:' + ip, LIMIT_DL) : 0);
  if (wait) return send(res, 429, `Too many requests, try again in ${wait} seconds`, 'text/plain; charset=utf-8', { 'Retry-After': String(wait) });

  const code = decId(url.searchParams.get('code') || '');
  if (!code) return send(res, 404, 'File not found or expired');

  const ac = new AbortController();
  res.on('close', () => ac.abort());   // stop the upstream download if the visitor cancels

  try {
    const hit = await getFile(code);
    if (!hit) return send(res, 404, 'File not found or expired');
    const { file, token } = hit;

    if (route === '/api/info') {
      return json(res, 200, { name: file.name, size: Number(file.size) || 0 });
    }

    if (activeTotal >= MAX_DL_TOTAL || (active.get(ip) || 0) >= MAX_DL_PER_IP) {
      return send(res, 429, 'Too many downloads running, try again shortly', 'text/plain; charset=utf-8', { 'Retry-After': '15' });
    }
    activeTotal++; bump(active, ip, 1);
    res.on('close', () => { activeTotal--; bump(active, ip, -1); });

    const h = { Authorization: `Bearer ${token}`, Cookie: `accountToken=${token}`, 'User-Agent': UA, Referer: 'https://gofile.io/' };
    for (const k of ['range', 'if-range']) if (req.headers[k]) h[k] = req.headers[k];
    const up = await fetch(file.link, { headers: h, signal: ac.signal });
    if (!up.ok && up.status !== 206) {
      fileCache.delete(code);            // link may have expired, look it up again next time
      return send(res, 502, 'Download failed upstream');
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
    console.error('proxy error:', e.message);
    if (!res.headersSent) send(res, 502, 'Download service request failed'); else res.destroy();
  }
});

server.requestTimeout = 20 * 60 * 1000;   // allow slow uploads of big files
server.keepAliveTimeout = 65000;          // longer than typical proxy idle timeouts
server.headersTimeout = 66000;
server.listen(PORT, () => {
  console.log(`FileSwap on :${PORT}`);
  if (!SECRET) console.warn('ID_SECRET is not set: uploads are disabled and raw Gofile codes are accepted');
  if (SECRET && !process.env.GOFILE_TOKEN) console.warn('GOFILE_TOKEN is not set: uploads use a temporary guest account and cannot be deleted after a restart');
});

// Railway sends SIGTERM when it replaces the container on a redeploy: exit cleanly so npm doesn't log an error
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
});
