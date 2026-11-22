const BASE = '/api';
const TIMEOUT_MS = 30_000;

let accessToken: string | null = localStorage.getItem('access_token');
let refreshToken: string | null = localStorage.getItem('refresh_token');

export function setTokens(access: string, refresh: string): void {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('access_token', access);
  localStorage.setItem('refresh_token', refresh);
}

export function clearTokens(): void {
  accessToken = refreshToken = null;
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
}

export function hasToken(): boolean {
  return accessToken !== null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function redirectToLogin(): void {
  // Avoid loops on the login page itself; preserve no state (magic links own their flow).
  if (window.location.pathname !== '/login') {
    clearTokens();
    window.location.assign('/login');
  }
}

async function refreshTokens(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    setTokens(body.accessToken, body.refreshToken);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiError(0, 'Request timed out — check your connection and retry.');
    }
    throw new ApiError(0, 'Network error — check your connection and retry.');
  } finally {
    clearTimeout(timer);
  }
}

/** JSON request with one silent refresh-retry on 401, timeout, and clean 401→login. */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const doFetch = (): Promise<Response> =>
    fetchWithTimeout(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  let res = await doFetch();
  if (res.status === 401 && (await refreshTokens())) {
    res = await doFetch();
  }
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const requestId = (payload.requestId as string | undefined) ?? undefined;
    const message = Array.isArray(payload.message)
      ? payload.message.join('; ')
      : String(payload.message ?? res.statusText);
    if (res.status === 401) redirectToLogin();
    if (res.status === 429) {
      throw new ApiError(429, 'Too many requests — wait a moment and try again.', requestId);
    }
    throw new ApiError(res.status, res.status >= 500 ? 'Server error — try again shortly.' : message, requestId);
  }
  return payload as T;
}

/** Multipart upload with auth + refresh handling. */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const send = (): Promise<Response> =>
    fetchWithTimeout(`${BASE}${path}`, {
      method: 'POST',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      body: form,
    });
  let res = await send();
  if (res.status === 401 && (await refreshTokens())) res = await send();
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    throw new ApiError(res.status, String(payload.message ?? res.statusText), payload.requestId as string | undefined);
  }
  return payload as T;
}

/** Authenticated binary download (xlsx export). */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (res.status === 401 && (await refreshTokens())) return apiDownload(path, filename);
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new ApiError(res.status, 'download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function login(email: string, password: string): Promise<void> {
  const res = await fetchWithTimeout(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, String(body.message ?? 'login failed'));
  }
  const body = asTokens(await res.json());
  setTokens(body.accessToken, body.refreshToken);
}

function asTokens(value: unknown): { accessToken: string; refreshToken: string } {
  return value as { accessToken: string; refreshToken: string };
}
