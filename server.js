// elkz Spotify overlay server
// Keeps you signed in to Spotify and streams what you're playing to the OBS overlay.
// No dependencies: needs Node 18 or newer.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ==================== SETTINGS ==================== */
loadEnvFile(path.join(__dirname, '.env'));

const CFG = {
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  publicUrl: (process.env.PUBLIC_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
  port: parseInt(process.env.PORT || '8787', 10),
  host: process.env.HOST || '127.0.0.1',
  setupPassword: process.env.SETUP_PASSWORD || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  pollMs: Math.max(1000, parseInt(process.env.POLL_MS || '2500', 10)),
  // only changed for testing against a fake Spotify
  accountsBase: process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com',
  apiBase: process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1',
};
const REDIRECT_URI = CFG.publicUrl + '/callback';
const SCOPES = 'user-read-currently-playing user-read-playback-state';
const TOKEN_FILE = path.join(CFG.dataDir, 'spotify-token.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] != null) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function log(...a) { console.log(new Date().toISOString(), ...a); }

/* ==================== SPOTIFY SIGN-IN ==================== */
let refreshToken = null;
let access = { token: null, expires: 0 };

function readToken() {
  try { refreshToken = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refresh_token || null; }
  catch { refreshToken = null; }
}
function saveToken(rt) {
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: rt, saved: new Date().toISOString() }), { mode: 0o600 });
  refreshToken = rt;
}

async function tokenRequest(params) {
  const res = await fetch(CFG.accountsBase + '/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(CFG.clientId + ':' + CFG.clientSecret).toString('base64'),
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('Spotify token request failed: ' + res.status + ' ' + (body.error_description || body.error || ''));
    err.status = res.status; err.code = body.error;
    throw err;
  }
  return body;
}

let refreshing = null;
async function accessToken() {
  if (access.token && Date.now() < access.expires - 60000) return access.token;
  if (!refreshToken) return null;
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
      .then((t) => {
        access = { token: t.access_token, expires: Date.now() + (t.expires_in || 3600) * 1000 };
        if (t.refresh_token && t.refresh_token !== refreshToken) saveToken(t.refresh_token);
        return access.token;
      })
      .catch((e) => {
        if (e.code === 'invalid_grant') {                // sign-in was revoked: needs signing in again
          log('Spotify sign-in is no longer valid. Visit', CFG.publicUrl + '/login to sign in again.');
          refreshToken = null;
          try { fs.unlinkSync(TOKEN_FILE); } catch {}
        } else log(e.message);
        access = { token: null, expires: 0 };
        return null;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

/* ==================== NOW PLAYING ==================== */
let current = { status: 'starting' };
let backoffUntil = 0;

function shape(data) {
  if (!data || !data.item) {
    if (data && data.currently_playing_type === 'ad') return { status: 'ad', playing: !!data.is_playing };
    return { status: 'idle', playing: false };
  }
  const it = data.item, ep = it.type === 'episode';
  const images = (ep ? (it.images || (it.show && it.show.images)) : (it.album && it.album.images)) || [];
  const img = images.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return {
    status: 'track',
    playing: !!data.is_playing,
    id: it.id || it.uri || it.name,
    type: ep ? 'episode' : 'track',
    title: it.name || '',
    artists: ep ? (it.show ? it.show.name : '') : (it.artists || []).map((a) => a.name).join(', '),
    album: ep ? '' : (it.album ? it.album.name : ''),
    art: img ? '/art?u=' + encodeURIComponent(img.url) : '',
    durationMs: it.duration_ms || 0,
    progressMs: data.progress_ms || 0,
    url: it.external_urls ? it.external_urls.spotify : '',
    at: Date.now(),
  };
}

async function poll() {
  if (Date.now() < backoffUntil) return;
  if (!refreshToken) { set({ status: 'signed-out' }); return; }
  const token = await accessToken();
  if (!token) { set({ status: refreshToken ? 'error' : 'signed-out' }); return; }
  let res;
  try {
    res = await fetch(CFG.apiBase + '/me/player/currently-playing?additional_types=track,episode', {
      headers: { Authorization: 'Bearer ' + token },
    });
  } catch (e) { log('Could not reach Spotify:', e.message); return; }
  if (res.status === 204) { set({ status: 'idle', playing: false }); return; }
  if (res.status === 401) { access = { token: null, expires: 0 }; return; }
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('retry-after') || '5', 10);
    backoffUntil = Date.now() + wait * 1000;
    log('Spotify asked us to slow down for', wait, 'seconds');
    return;
  }
  if (!res.ok) { log('Spotify returned', res.status); return; }
  set(shape(await res.json().catch(() => null)));
}

// Only send an update when something viewers would see has changed (or the position jumped).
function set(next) {
  const prev = current;
  current = next;
  const changed = prev.status !== next.status || prev.id !== next.id || prev.playing !== next.playing ||
    (next.status === 'track' && prev.status === 'track' &&
      Math.abs((prev.progressMs + (prev.playing ? next.at - prev.at : 0)) - next.progressMs) > 2500);
  if (changed) broadcast();
}

/* ---------- live updates to overlays (Server-Sent Events) ---------- */
const clients = new Set();
let timer = null;
// the position as of right now, so overlays don't need our clock
function snapshot() {
  const c = Object.assign({}, current);
  if (c.status === 'track' && c.playing) { c.progressMs = Math.min(c.durationMs || Infinity, c.progressMs + (Date.now() - c.at)); }
  c.at = Date.now();
  return JSON.stringify(c);
}
function broadcast() {
  const msg = 'data: ' + snapshot() + '\n\n';
  for (const res of clients) res.write(msg);
}
function startPolling() {
  if (timer) return;
  poll();
  timer = setInterval(poll, CFG.pollMs);
}
function stopPollingIfIdle() {
  if (clients.size || !timer) return;
  clearInterval(timer); timer = null;               // nobody is watching: stop asking Spotify
}
setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 20000);

/* ==================== WEB SERVER ==================== */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
const STATIC = new Set(['overlay.html', 'overlay.css', 'overlay.js', 'ElkzDisplay.woff', 'setup.html']);
const pendingStates = new Map();

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
function page(title, inner) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#131518;color:#EEEDE9;max-width:640px;margin:0 auto;padding:40px 20px}' +
    'a{color:#E86200}code{background:#1f2328;padding:2px 6px}input,button{font:inherit;padding:8px 10px}button{background:#E86200;border:0;color:#131518;font-weight:700;cursor:pointer}</style>' +
    '<h1>' + title + '</h1>' + inner;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/') {
      const signed = !!refreshToken;
      return send(res, 200, page('elkz Spotify overlay',
        '<p>Spotify: <b>' + (signed ? 'signed in' : 'not signed in') + '</b></p>' +
        '<p>' + (signed ? 'Sign in again' : 'Sign in') + ': <a href="/login">/login</a></p>' +
        '<p>Overlay for OBS: <code>' + esc(CFG.publicUrl) + '/overlay</code></p>' +
        '<p>Pick the look and copy the URL: <a href="/setup">/setup</a></p>' +
        '<p>Preview without Spotify: <a href="/overlay?demo=1">/overlay?demo=1</a></p>'), 'text/html; charset=utf-8');
    }

    if (p === '/login') {
      if (!CFG.clientId || !CFG.clientSecret) return send(res, 500, 'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are not set. See the README.');
      if (!CFG.setupPassword) return send(res, 500, 'Set SETUP_PASSWORD in .env first, so nobody else can sign this overlay in to their Spotify.');
      if (!safeEqual(url.searchParams.get('key') || '', CFG.setupPassword)) {
        return send(res, 200, page('Sign in to Spotify',
          '<form method="get" action="/login"><p>Setup password (from your .env file):</p>' +
          '<p><input type="password" name="key" autocomplete="current-password" required> <button>Continue to Spotify</button></p></form>'), 'text/html; charset=utf-8');
      }
      const state = crypto.randomBytes(16).toString('hex');
      pendingStates.set(state, Date.now());
      for (const [k, t] of pendingStates) if (Date.now() - t > 600000) pendingStates.delete(k);
      const q = new URLSearchParams({ response_type: 'code', client_id: CFG.clientId, scope: SCOPES, redirect_uri: REDIRECT_URI, state });
      return send(res, 302, '', null, { Location: CFG.accountsBase + '/authorize?' + q });
    }

    if (p === '/callback') {
      const state = url.searchParams.get('state');
      if (!state || !pendingStates.has(state)) return send(res, 400, page('Sign-in expired', '<p>That sign-in link is old or was not started here. <a href="/login">Try again</a>.</p>'), 'text/html; charset=utf-8');
      pendingStates.delete(state);
      if (url.searchParams.get('error')) return send(res, 400, page('Spotify said no', '<p>' + esc(url.searchParams.get('error')) + '. <a href="/login">Try again</a>.</p>'), 'text/html; charset=utf-8');
      const t = await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: REDIRECT_URI });
      saveToken(t.refresh_token);
      access = { token: t.access_token, expires: Date.now() + (t.expires_in || 3600) * 1000 };
      log('Signed in to Spotify');
      if (clients.size) poll();
      return send(res, 200, page('Signed in', '<p>Done. The overlay will now show what you play on Spotify.</p><p>OBS browser source URL: <code>' + esc(CFG.publicUrl) + '/overlay</code></p>'), 'text/html; charset=utf-8');
    }

    if (p === '/api/now-playing') {
      if (!timer) await poll();
      return send(res, 200, snapshot(), 'application/json', { 'Access-Control-Allow-Origin': '*' });
    }

    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => { clients.delete(res); setTimeout(stopPollingIfIdle, 5000); });
      if (current.status !== 'starting') res.write('data: ' + snapshot() + '\n\n');
      startPolling();
      return;
    }

    // album art through this server, so the overlay can read its colours
    if (p === '/art') {
      let u;
      try { u = new URL(url.searchParams.get('u') || ''); } catch { return send(res, 400, 'bad url'); }
      if (u.protocol !== 'https:' || !/(^|\.)scdn\.co$|(^|\.)spotifycdn\.com$/.test(u.hostname)) return send(res, 400, 'not a Spotify image');
      const r = await fetch(u);
      if (!r.ok) return send(res, 502, 'image not available');
      const buf = Buffer.from(await r.arrayBuffer());
      return send(res, 200, buf, r.headers.get('content-type') || 'image/jpeg', { 'Cache-Control': 'public, max-age=86400' });
    }

    // pictures for the StreamElements scenes (background etc.), readable from any site
    if (p.startsWith('/assets/')) {
      const file = path.basename(p);
      const full = path.join(PUBLIC_DIR, 'assets', file);
      if (!/^[\w.-]+\.(jpg|png|webp)$/.test(file) || !fs.existsSync(full)) return send(res, 404, 'Not found');
      return send(res, 200, fs.readFileSync(full), file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
        { 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    }

    const name = p === '/overlay' ? 'overlay.html' : p === '/setup' ? 'setup.html' : p.slice(1);
    if (STATIC.has(name)) {
      const body = fs.readFileSync(path.join(PUBLIC_DIR, name));
      return send(res, 200, body, TYPES[path.extname(name)], name === 'ElkzDisplay.woff' ? { 'Cache-Control': 'public, max-age=604800' } : null);
    }
    send(res, 404, 'Not found');
  } catch (e) {
    log('Error on', p, e.message);
    if (!res.headersSent) send(res, 500, 'Something went wrong: ' + e.message);
  }
});

readToken();
server.listen(CFG.port, CFG.host, () => {
  log('elkz Spotify overlay running on http://' + CFG.host + ':' + CFG.port);
  log('Public address:', CFG.publicUrl, refreshToken ? '(signed in to Spotify)' : '(not signed in yet: open ' + CFG.publicUrl + '/login)');
  if (!CFG.clientId || !CFG.clientSecret) log('Warning: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are missing. See the README.');
});
