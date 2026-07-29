import { useEffect, useState } from 'react';
import { setServerUrl, setToken, serverOrigin, getToken } from '../lib/serverConfig';
import * as api from '../lib/api';

// PKCE (RFC 7636) for native sign-in: generate a verifier, send only its S256
// challenge to the server, then exchange the returned code + verifier for tokens.
const PKCE_KEY = 'openchat.pkceVerifier';
function b64url(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/**
 * First-run screen for the native (desktop) shell. Preferred path: enter the server
 * address and "Sign in" — this opens the normal browser SSO, and the server hands a
 * token back to the app via the openchat:// deep link (no manual token paste).
 * A manual token field is kept as a fallback.
 */
export function DesktopSetup({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState(serverOrigin() || 'https://');
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualToken, setManualToken] = useState(getToken() || '');
  const [busy, setBusy] = useState(false);

  // The shell emits "auth-code" (PKCE, preferred) or "auth-token" (legacy) once SSO completes.
  useEffect(() => {
    const t = (window as any).__TAURI__;
    if (!t?.event?.listen) return;
    const unlisteners: Array<() => void> = [];
    t.event.listen('auth-code', async (e: any) => {
      const code = e?.payload ? String(e.payload) : '';
      let verifier = ''; try { verifier = sessionStorage.getItem(PKCE_KEY) || ''; } catch { /* ignore */ }
      if (!code || !verifier) return;
      try {
        await api.exchangeAuthCode(code, verifier, 'openchat://auth');
        try { sessionStorage.removeItem(PKCE_KEY); } catch { /* ignore */ }
        window.location.reload();
      } catch { setErr('Sign-in failed — please try again.'); setWaiting(false); }
    }).then((u: () => void) => { unlisteners.push(u); }).catch(() => {});
    // Legacy fallback: older servers/builds still hand back a raw token.
    t.event.listen('auth-token', (e: any) => {
      const token = e?.payload ? String(e.payload) : '';
      if (token) { setToken(token); window.location.reload(); }
    }).then((u: () => void) => { unlisteners.push(u); }).catch(() => {});
    return () => { unlisteners.forEach((u) => u()); };
  }, []);

  function normalizedUrl(): string | null {
    const u = url.trim().replace(/\/$/, '');
    if (!/^https?:\/\/.+/.test(u)) { setErr('Enter your server address (https://…).'); return null; }
    return u;
  }

  async function signIn() {
    const u = normalizedUrl();
    if (!u) return;
    setErr(null);
    setServerUrl(u);
    const t = (window as any).__TAURI__;
    try {
      const { verifier, challenge } = await makePkce();
      try { sessionStorage.setItem(PKCE_KEY, verifier); } catch { /* ignore */ }
      const target = `${u}/api/auth/desktop?code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
      await t.core.invoke('open_external', { url: target });
      setWaiting(true);
    } catch {
      setErr('Could not open the browser. Try the manual token option below.');
    }
  }

  async function connectManual() {
    const u = normalizedUrl();
    if (!u) return;
    const tok = manualToken.trim();
    if (!tok) { setErr('Paste an app token, or use Sign in above.'); return; }
    setBusy(true); setErr(null);
    setServerUrl(u); setToken(tok);
    try {
      await api.getMe();
      onDone();
    } catch {
      setServerUrl(''); setToken(null);
      setErr('Could not connect — check the server address and token.');
      setBusy(false);
    }
  }

  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text)', outline: 'none', fontSize: 14,
  };
  const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--muted)', margin: '0 0 6px' };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: 380, background: 'var(--panel)', borderRadius: 12, padding: 28, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 20, color: 'var(--text-strong)' }}>Welcome to OpenChat</h2>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--muted)' }}>Connect to your server and sign in.</p>

        <label style={label}>Server address</label>
        <input style={{ ...input, marginBottom: 16 }} value={url} placeholder="https://chat.example.com"
          onChange={(e) => setUrl(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') signIn(); }} />

        {err && <p style={{ color: 'var(--danger)', fontSize: 13, margin: '0 0 14px' }}>{err}</p>}

        {waiting ? (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'var(--text)', margin: '0 0 10px' }}>Finish signing in in your browser…</p>
            <button onClick={() => setWaiting(false)}
              style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        ) : (
          <button onClick={signIn}
            style={{ width: '100%', padding: '11px 0', borderRadius: 7, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>
            Sign in
          </button>
        )}

        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          {!showManual ? (
            <button onClick={() => setShowManual(true)}
              style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>
              Advanced: use an app token
            </button>
          ) : (
            <>
              <label style={label}>App token</label>
              <input style={{ ...input, marginBottom: 10 }} value={manualToken} placeholder="oc_…" type="password"
                onChange={(e) => setManualToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') connectManual(); }} />
              <button onClick={connectManual} disabled={busy}
                style={{ width: '100%', padding: '9px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: busy ? 'default' : 'pointer', fontWeight: 600, fontSize: 13 }}>
                {busy ? 'Connecting…' : 'Connect with token'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
