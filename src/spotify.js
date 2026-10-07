// Spotify Web API: like/unlike the current song and play your playlists.
// Uses the Authorization Code + PKCE flow, so it needs only a Client ID (from your own
// app at developer.spotify.com) and no secret. Tokens are stored encrypted by main.
const http = require('http');
const crypto = require('crypto');

const PORT = 47778;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ['user-library-read', 'user-library-modify', 'user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private'];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * opts: { clientId(), loadRefresh(), saveRefresh(token|null), openUrl(url) }
 */
function create(opts) {
  let access = null;
  let expires = 0;

  async function tokenRequest(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: opts.clientId(), ...params }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
    access = data.access_token;
    expires = Date.now() + (data.expires_in - 60) * 1000;
    if (data.refresh_token) opts.saveRefresh(data.refresh_token);
    return access;
  }

  async function token() {
    if (access && Date.now() < expires) return access;
    const refresh = opts.loadRefresh();
    if (!refresh) throw new Error('not connected');
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  }

  async function api(method, path, body) {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      const err = new Error(res.status === 403 && /premium/i.test(msg) ? 'That needs Spotify Premium' : msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    connected: () => Boolean(opts.loadRefresh()),

    /** Opens Spotify's consent page in your browser and waits for the redirect. */
    connect() {
      return new Promise((resolve, reject) => {
        if (!opts.clientId()) return reject(new Error('Add your Spotify Client ID first'));
        const verifier = b64url(crypto.randomBytes(64));
        const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
        const state = b64url(crypto.randomBytes(16));
        const server = http.createServer(async (req, res) => {
          const url = new URL(req.url, REDIRECT);
          if (url.pathname !== '/callback') {
            res.writeHead(404);
            res.end();
            return;
          }
          const done = (ok, text) => {
            res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<body style="background:#000;color:#fff;font:16px monospace;display:grid;place-items:center;height:100vh;margin:0">${text}</body>`);
            server.close();
          };
          if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
            done(false, 'Spotify sign-in was cancelled. You can close this tab.');
            return reject(new Error(url.searchParams.get('error') || 'cancelled'));
          }
          try {
            await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: verifier });
            done(true, '● Apron is connected to Spotify. You can close this tab.');
            resolve(true);
          } catch (err) {
            done(false, `Spotify said: ${err.message}`);
            reject(err);
          }
        });
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1', () => {
          const q = new URLSearchParams({
            client_id: opts.clientId(),
            response_type: 'code',
            redirect_uri: REDIRECT,
            code_challenge_method: 'S256',
            code_challenge: challenge,
            state,
            scope: SCOPES.join(' '),
          });
          opts.openUrl(`https://accounts.spotify.com/authorize?${q}`);
        });
        setTimeout(() => {
          server.close();
          reject(new Error('timed out'));
        }, 5 * 60e3).unref();
      });
    },

    disconnect() {
      access = null;
      opts.saveRefresh(null);
    },

    /** { id, liked } for what's playing on Spotify right now, or null. */
    async current() {
      const now = await api('GET', '/me/player/currently-playing');
      const item = now && now.item;
      if (!item || item.type !== 'track') return null;
      const [liked] = await api('GET', `/me/tracks/contains?ids=${item.id}`);
      return { id: item.id, name: item.name, liked: Boolean(liked) };
    },

    async setLiked(id, liked) {
      await api(liked ? 'PUT' : 'DELETE', `/me/tracks?ids=${encodeURIComponent(id)}`);
      return liked;
    },

    async playlists() {
      const data = await api('GET', '/me/playlists?limit=30');
      return (data.items || []).filter(Boolean).map((p) => ({ name: p.name, uri: p.uri, tracks: p.tracks ? p.tracks.total : null }));
    },

    async play(uri) {
      if (!/^spotify:(playlist|album):[A-Za-z0-9]+$/.test(uri)) throw new Error('bad playlist');
      await api('PUT', '/me/player/play', { context_uri: uri });
    },
  };
}

module.exports = { create, REDIRECT, SCOPES };
