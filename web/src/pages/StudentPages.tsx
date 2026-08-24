import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { claimMagicLink, openMagicLink } from '../lib/magic';

/** Entry point for the emailed magic link: /magic/<jwt> */
export function MagicEntryPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<'opening' | 'ready' | 'claimed' | 'error'>('opening');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        await openMagicLink(token);
        setState('ready');
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Invalid link');
        setState('error');
      }
    })();
  }, [token]);

  async function claim(): Promise<void> {
    try {
      const claimed = await claimMagicLink(token);
      setState('claimed');
      navigate(`/lobby?period=${claimed.periodId}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Claim failed');
      setState('error');
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Thesis Selection — FKUI</h1>
      {state === 'opening' && <p className="text-slate-500">Verifying your link…</p>}
      {state === 'ready' && (
        <>
          <p className="rounded-lg bg-emerald-100 px-4 py-3 text-sm text-emerald-800">
            Link verified and bound to this device. Continue to enter your lobby — you have a
            limited window to complete this step.
          </p>
          <button onClick={() => void claim()} className="w-full rounded-lg bg-slate-900 py-3 text-white">
            Enter selection lobby
          </button>
          <p className="text-xs text-slate-500">This link works on this device only.</p>
        </>
      )}
      {state === 'claimed' && <p className="text-emerald-700">Entering…</p>}
      {state === 'error' && (
        <>
          <p className="rounded-lg bg-red-100 px-4 py-3 text-sm text-red-700">{message}</p>
          <Link to="/rules" className="text-sm text-slate-600 underline">Read the rules guide</Link>
        </>
      )}
    </main>
  );
}

interface LobbyView {
  serverTime: string;
  period: { id: string; name: string; status: string; opensAt: string | null; closesAt: string | null };
  secondsUntilOpen: number | null;
  autoWar: { enabled: boolean; consentedAt: string | null };
  preference: { text: string; updatedAt: string } | null;
}

/** Countdown driven by SERVER time: skew measured per poll, never trusted locally. */
function useServerCountdown(view: LobbyView | null): number | null {
  const [skewMs, setSkewMs] = useState(0);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!view) return;
    setSkewMs(Date.parse(view.serverTime) - Date.now());
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [view?.serverTime]);

  if (!view?.period.opensAt) return null;
  const opensAtMs = Date.parse(view.period.opensAt);
  return Math.max(0, Math.floor((opensAtMs - (Date.now() + skewMs)) / 1000));
}

function fmtCountdown(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} (WIB-synced)`;
}

export function LobbyPage() {
  const params = new URLSearchParams(window.location.search);
  const periodId = params.get('period') ?? '';
  const [view, setView] = useState<LobbyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interests, setInterests] = useState('');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  const countdown = useServerCountdown(view);

  const load = useCallback(async () => {
    try {
      const v = await api<LobbyView>(`/lobby?periodId=${periodId}`);
      setView(v);
      if (v.preference) setInterests(v.preference.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [periodId]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function savePreferences(): Promise<void> {
    try {
      await api('/lobby/preferences', { method: 'POST', body: { periodId, text: interests } });
      setSavedMsg('Saved — F5 will use this for instant fallback matching.');
      await load();
    } catch (err) {
      setSavedMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function setAutoWar(enabled: boolean): Promise<void> {
    try {
      await api('/lobby/auto-war', {
        method: 'POST',
        body: { periodId, enabled, consent: enabled ? true : undefined },
      });
      await load();
    } catch (err) {
      setSavedMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6">
        <p className="rounded-lg bg-red-100 px-4 py-3 text-sm text-red-700">{error}</p>
        <Link to="/rules" className="text-sm underline">Rules guide</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-5 p-4 sm:p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{view?.period.name ?? 'Lobby'}</h1>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">{view?.period.status}</span>
      </header>

      <section className="rounded-2xl border bg-white p-6 text-center shadow-sm">
        <p className="text-sm text-slate-500">Selection opens in</p>
        <p data-testid="countdown" className="my-2 text-4xl font-bold tabular-nums">
          {countdown === null ? '—' : countdown === 0 ? 'OPEN' : fmtCountdown(countdown)}
        </p>
        <p className="text-xs text-slate-400">
          Server-authoritative clock · rendered in WIB · do not rely on your device time
        </p>
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border bg-white p-4 shadow-sm">
        <h2 className="font-medium">Your research interests</h2>
        <p className="text-xs text-slate-500">
          If your first pick is taken at the opening moment, we use this to suggest the best
          available match instantly.
        </p>
        <textarea
          rows={4}
          minLength={20}
          maxLength={2000}
          value={interests}
          onChange={(e) => setInterests(e.target.value)}
          placeholder="e.g. Community nutrition programs, maternal health, field surveys in rural areas…"
          className="w-full rounded-lg border p-3 text-sm"
        />
        <div className="flex items-center justify-between">
          <button
            disabled={interests.trim().length < 20}
            onClick={() => void savePreferences()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            Save preferences
          </button>
          {savedMsg && <span className="text-xs text-slate-500">{savedMsg}</span>}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Auto-war</h2>
          {view && (
            <span className={`rounded-full px-2 py-0.5 text-xs ${view.autoWar.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100'}`}>
              {view.autoWar.enabled ? 'armed' : 'off'}
            </span>
          )}
        </div>
        <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
          <li><strong>Tab must stay open.</strong> At the opening second the system locks the best-matching title only if this page is visible. Background tabs are skipped — that is fairness.</li>
          <li>You confirm NOW which title class you accept; no modal will appear during the war.</li>
          <li>This is opt-in. Without it you tap manually like everyone else.</li>
          {!tabVisible && <li className="font-medium text-red-600">This tab is currently in the background — re-open it before the war.</li>}
        </ul>
        {view?.autoWar.enabled ? (
          <button onClick={() => void setAutoWar(false)} className="rounded-lg border px-4 py-2 text-sm">
            Disarm auto-war
          </button>
        ) : (
          <label className="flex items-start gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} className="mt-0.5" />
            I explicitly pre-confirm automated locking of the best-matching available title at
            opens_at, provided this tab stays open.
          </label>
        )}
        {!view?.autoWar.enabled && (
          <button
            disabled={!consentChecked}
            onClick={() => void setAutoWar(true)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            Arm auto-war
          </button>
        )}
      </section>

      <footer className="pb-6 text-center text-xs text-slate-500">
        Read the <Link to="/rules" className="underline">selection rules guide</Link> before the war.
      </footer>
    </main>
  );
}
