import { clearTokens, setTokens } from './api';

/** Stable per-browser fingerprint — magic links bind to the FIRST device. */
export function getFingerprint(): string {
  let fp = localStorage.getItem('device_fingerprint');
  if (!fp) {
    fp = crypto.randomUUID();
    localStorage.setItem('device_fingerprint', fp);
  }
  return fp;
}

export async function openMagicLink(token: string): Promise<{ expiresAt: string; periodId: string }> {
  const res = await fetch('/api/magic/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, fingerprint: getFingerprint() }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.message ?? `HTTP ${res.status}`));
  return body as { expiresAt: string; periodId: string };
}

/** Claims the link (single-use) and stores the session pair. */
export async function claimMagicLink(token: string): Promise<{ periodId: string }> {
  const res = await fetch('/api/magic/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, fingerprint: getFingerprint() }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.message ?? `HTTP ${res.status}`));
  const tokens = body as unknown as { accessToken: string; refreshToken: string };
  setTokens(tokens.accessToken, tokens.refreshToken);
  // periodId rides inside the JWT payload; decode without verification (client-side hint only)
  const payload = JSON.parse(atob(tokens.accessToken.split('.')[1]!)) as { periodId: string };
  return { periodId: payload.periodId };
}

export function studentLogout(): void {
  clearTokens();
}
