// Where the client talks to the OpenChat server. The web build defaults to
// same-origin (unchanged); native shells (desktop/mobile) have no same-origin
// server, so they set an explicit origin — via a stored value (first-run "server
// URL" field) or a build-time VITE_SERVER_URL — and authenticate with a bearer token.

const SERVER_URL_KEY = 'openchat.serverUrl';
const TOKEN_KEY = 'openchat.token';

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** '' = same-origin (web); otherwise 'https://host' (no trailing slash). */
export function serverOrigin(): string {
  const stored = safeGet(SERVER_URL_KEY);
  if (stored) return stored.replace(/\/$/, '');
  const env = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  return '';
}

export function setServerUrl(url: string) {
  try { localStorage.setItem(SERVER_URL_KEY, url.replace(/\/$/, '')); } catch { /* ignore */ }
}

/** REST base, e.g. '' -> '/api' (same-origin) or 'https://host/api'. */
export function apiBase(): string {
  return `${serverOrigin()}/api`;
}

/** Absolute ws(s) URL for a server-relative path like '/ws?ticket=…'. */
export function wsUrl(path: string): string {
  const origin = serverOrigin();
  const base = origin || window.location.origin;
  const u = new URL(base);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}${path}`;
}

/**
 * Absolute URL for a server media path used directly by <img>/<video> elements. Those can't
 * send an Authorization header, so we (a) make the URL absolute (needed on native origins)
 * and (b) append the bearer token as ?token= when present (the API guard accepts it). Web
 * sessions without a token fall back to the same-origin cookie.
 */
export function mediaUrl(path: string): string {
  const url = `${serverOrigin()}${path}`;
  const token = getToken();
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

// ---- bearer tokens (native clients; web uses the session cookie) ----
// Native clients authenticate with a short-lived access token + a rotating refresh
// token (OAuth Authorization-Code + PKCE, issued by POST /auth/oauth/token). The web
// build uses the session cookie and stores nothing here. TOKEN_KEY keeps its historical
// name so an existing install's stored token keeps working until the next sign-in.
const REFRESH_KEY = 'openchat.refresh';
const EXP_KEY = 'openchat.tokenExp';

/** Access token sent as `Authorization: Bearer` (and as ?token= for media). */
export function getToken(): string | null { return safeGet(TOKEN_KEY); }
export function getRefreshToken(): string | null { return safeGet(REFRESH_KEY); }
export function getTokenExpiry(): number { const v = safeGet(EXP_KEY); return v ? Number(v) : 0; }

/** Store a token family from an /auth/oauth/token response (login or refresh). */
export function setTokens(t: { accessToken: string; refreshToken?: string; expiresIn?: number }) {
  try {
    localStorage.setItem(TOKEN_KEY, t.accessToken);
    if (t.refreshToken) localStorage.setItem(REFRESH_KEY, t.refreshToken);
    if (t.expiresIn) localStorage.setItem(EXP_KEY, String(Date.now() + t.expiresIn * 1000));
  } catch { /* ignore */ }
}

/** Back-compat single-token setter: sets just the access token (e.g. manual paste),
 *  or clears the whole family when passed null. Prefer setTokens()/clearTokens(). */
export function setToken(token: string | null) {
  if (token === null) { clearTokens(); return; }
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}

export function clearTokens() {
  try { [TOKEN_KEY, REFRESH_KEY, EXP_KEY].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
}
