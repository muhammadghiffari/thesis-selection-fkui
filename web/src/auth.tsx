import { useEffect, useState } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { api, clearTokens, hasToken, setTokens } from './lib/api';

interface Profile {
  id: string;
  email: string;
  role: 'admin' | 'lecturer' | 'student';
}

/** Client-side role gate; the server enforces the real boundary. */
export function RequireRole(roles: Array<'admin' | 'lecturer'>) {
  return function RoleGate() {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      if (!hasToken()) {
        setFailed(true);
        return;
      }
      api<Profile>('/auth/me')
        .then((p) => setProfile(p))
        .catch(() => setFailed(true));
    }, []);

    if (failed) return <Navigate to="/login" replace />;
    if (!profile) return <p className="p-6 text-slate-500">Loading…</p>;
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
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error('Invalid credentials');
      const body = (await res.json()) as { accessToken: string; refreshToken: string; user?: { role?: string } };
      setTokens(body.accessToken, body.refreshToken);
      navigate(body.user?.role === 'lecturer' ? '/lecturer' : '/students');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
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
