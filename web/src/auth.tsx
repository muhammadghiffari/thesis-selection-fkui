import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, clearTokens, hasToken, setTokens } from './lib/api';

interface Profile {
  id: string;
  email: string;
  role: 'admin' | 'lecturer' | 'student';
}

/** Client-side role gate; the server enforces the real boundary. */
export function RequireRole(roles: Array<'admin' | 'lecturer'>) {
  return function RoleGate() {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [failed, setFailed] = useState<'unauth' | 'forbidden' | null>(null);

    useEffect(() => {
      if (!hasToken()) {
        setFailed('unauth');
        return;
      }
      api<Profile>('/auth/me')
        .then((p) => setProfile(p))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 403) setFailed('forbidden');
          else setFailed('unauth');
        });
    }, []);

    if (failed === 'unauth') return <Navigate to="/login" replace />;
    if (!profile) {
      if (failed === 'forbidden') {
        return (
          <main className="mx-auto max-w-md p-6 text-center">
            <p className="text-5xl font-bold text-slate-300">403</p>
            <h1 className="mt-2 text-lg font-semibold">Access forbidden</h1>
            <p className="mt-1 text-sm text-slate-600">Your role cannot view this area.</p>
            <p className="mt-3"><Link to="/login" className="underline">Go to sign in</Link></p>
          </main>
        );
      }
      return <p className="p-6 text-slate-500">Loading…</p>;
    }
    if (!roles.includes(profile.role as 'admin' | 'lecturer')) {
      return <Navigate to="/login" replace />;
    }
    return <Outlet context={profile} />;
  };
}

export const RequireAdmin = RequireRole(['admin']);

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.status === 429) throw new Error('Too many attempts — wait a moment and try again.');
      if (!res.ok) throw new Error('Invalid credentials');
      const body = (await res.json()) as { accessToken: string; refreshToken: string; user?: { role?: string } };
      setTokens(body.accessToken, body.refreshToken);
      navigate(body.user?.role === 'lecturer' ? '/lecturer' : '/students');
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Request timed out — check your connection and retry.'
          : err instanceof Error
            ? err.message
            : 'login failed',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Thesis Selection — Staff</h1>
      <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-sm">
        <label className="text-sm">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2"
          />
        </label>
        <label className="text-sm">
          Password
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2"
          />
        </label>
        {error && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button
          disabled={busy}
          className="rounded-lg bg-slate-900 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-center text-sm">
          <Link to="/forgot-password" className="underline">Forgot password?</Link>
        </p>
      </form>
    </main>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.status === 429) throw new Error('Too many requests — wait a moment and try again.');
      if (!res.ok) throw new Error('Could not submit request');
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Reset password</h1>
      {sent ? (
        <div className="rounded-xl border bg-white p-4 text-sm shadow-sm">
          <p>If an account exists for that email, a reset link was sent. It expires in 30 minutes and can be used once.</p>
          <p className="mt-2"><Link to="/login" className="underline">Back to sign in</Link></p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-sm">
          <label className="text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            />
          </label>
          {error && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button disabled={busy} className="rounded-lg bg-slate-900 py-2 text-white disabled:opacity-50">
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </main>
  );
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(String(body.message ?? 'Reset failed — link may have expired'));
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reset failed');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <main className="mx-auto max-w-sm p-6 text-center">
        <p className="text-5xl font-bold text-slate-300">400</p>
        <p className="mt-2 text-sm text-slate-600">Missing reset token. Request a new link.</p>
        <p className="mt-2"><Link to="/forgot-password" className="underline">Request new link</Link></p>
      </main>
    );
  }
  if (done) {
    return (
      <main className="mx-auto max-w-sm p-6 text-center">
        <h1 className="text-lg font-semibold">Password updated</h1>
        <p className="mt-1 text-sm text-slate-600">All previous sessions were revoked. Sign in with your new password.</p>
        <button onClick={() => navigate('/login')} className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">Sign in</button>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Set a new password</h1>
      <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-sm">
        <label className="text-sm">
          New password
          <input
            type="password"
            required
            minLength={8}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2"
          />
        </label>
        {error && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="rounded-lg bg-slate-900 py-2 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Reset password'}
        </button>
      </form>
    </main>
  );
}

export function LogoutButton() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => {
        clearTokens();
        navigate('/login');
      }}
      className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-100"
    >
      Sign out
    </button>
  );
}
