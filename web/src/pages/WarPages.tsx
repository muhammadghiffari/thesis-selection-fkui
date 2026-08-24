import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../lib/api';

interface Catalog {
  mySelections: Array<{
    id: string;
    thesisId: string;
    priority: number;
    status: string;
    confirmedAt: string | null;
    referenceNumber: string | null;
    title: string;
  }>;
  required: number;
  theses: Array<{
    id: string;
    title: string;
    track: string;
    lecturerName: string | null;
    status: 'available' | 'locked' | 'taken';
    lockedByMe: boolean;
    lockedUntil: string | null;
  }>;
}

type CardState = 'available' | 'locked' | 'mine-locked' | 'mine-taken' | 'taken';

/** AGENTS.md UI vocabulary: green tap / gray timer / faded taken. */
function cardStyle(state: CardState): string {
  switch (state) {
    case 'available': return 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100';
    case 'mine-locked': return 'border-slate-400 bg-slate-100 ring-2 ring-slate-500';
    case 'locked': return 'border-slate-200 bg-slate-100 opacity-70';
    case 'mine-taken': return 'border-emerald-500 bg-emerald-100';
    case 'taken': return 'border-slate-200 bg-slate-50 opacity-40';
  }
}

export function WarRoomPage() {
  const [params] = useSearchParams();
  const periodId = params.get('period') ?? '';
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!periodId) return;
    try {
      setCatalog(await api<Catalog>(`/war/catalog?periodId=${periodId}`));
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }, [periodId]);

  useEffect(() => void load(), [load]);

  // live-ish grid + heartbeat while tab visible
  useEffect(() => {
    if (!periodId) return;
    pollRef.current = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api('/war/heartbeat', { method: 'POST', body: { periodId } }).catch(() => undefined);
      void load();
    }, 4000);
    void api('/war/heartbeat', { method: 'POST', body: { periodId } }).catch(() => undefined);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [periodId, load]);

  const mineLocked = catalog?.mySelections.find((m) => m.status === 'locked') ?? null;
  const activeCount = catalog?.mySelections.length ?? 0;

  async function tap(thesisId: string): Promise<void> {
    if (busyId || mineLocked || activeCount >= (catalog?.required ?? 3)) return;
    setBusyId(thesisId);
    try {
      const res = await api<{ status: string; fallback?: { title: string } | null }>('/war/claims', {
        method: 'POST',
        body: { periodId, thesisId, idempotencyKey: crypto.randomUUID() },
      });
      if (res.status === 'lost') {
        setBanner(res.fallback ? `Taken! Closest free match: "${res.fallback.title}"` : 'Taken — try another');
      }
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function action(id: 'confirm' | 'release' | 'undo'): Promise<void> {
    if (!mineLocked && id !== 'undo') return;
    const target = id === 'undo' ? catalog?.mySelections.find((m) => m.status === 'confirmed' && !m.referenceNumber)?.id ?? catalog?.mySelections.at(-1)?.id : mineLocked!.id;
    if (!target) return;
    try {
      await api(`/war/claims/${target}/${id}`, { method: 'POST' });
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  function stateOf(thesisId: string): CardState {
    const t = catalog!.theses.find((x) => x.id === thesisId)!;
    const mine = catalog!.mySelections.find((m) => m.thesisId === thesisId);
    if (mine && (mine.status === 'confirmed' || mine.status === 'taken')) return 'mine-taken';
    if (mine && mine.status === 'locked') return 'mine-locked';
    if (t.status === 'taken') return 'taken';
    if (t.status === 'locked') return 'locked';
    return 'available';
  }

  const cards = useMemo(() => catalog?.theses ?? [], [catalog]);

  return (
    <div className="flex flex-col gap-4">
      {/* sticky progress tracker */}
      <div className="sticky top-[52px] z-10 -mx-1 flex items-center justify-between rounded-xl bg-white/95 px-4 py-2 shadow-sm ring-1 ring-slate-200 backdrop-blur">
        <span className="text-sm">
          Titles claimed:{' '}
          <strong className="tabular-nums">{activeCount}/{catalog?.required ?? 3}</strong>
          <span className="ml-2 inline-flex gap-0.5 align-middle">
            {Array.from({ length: catalog?.required ?? 3 }).map((_, i) => (
              <span key={i} className={`inline-block h-2.5 w-6 rounded-full ${i < activeCount ? 'bg-emerald-500' : 'bg-slate-200'}`} />
            ))}
          </span>
        </span>
        {activeCount >= (catalog?.required ?? 3) && (
          <Link to={`/receipt?period=${periodId}`} className="text-sm underline">View receipt →</Link>
        )}
      </div>

      {banner && (
        <p role="status" className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
          {banner}
          <button className="ml-2 underline" onClick={() => setBanner(null)}>dismiss</button>
        </p>
      )}

      {mineLocked && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-300 bg-slate-50 p-3 text-sm">
          <strong>{mineLocked.title}</strong>
          <span className="text-xs text-slate-500">locked — decide now</span>
          <button onClick={() => void action('confirm')} className="ml-auto rounded-lg bg-emerald-600 px-4 py-1.5 text-white">
            Claim final
          </button>
          <button onClick={() => void action('release')} className="rounded-lg border px-4 py-1.5">Release</button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((t) => {
          const st = stateOf(t.id);
          const interactive = st === 'available' && !mineLocked && busyId === null && activeCount < (catalog?.required ?? 3);
          return (
            <button
              key={t.id}
              disabled={!interactive}
              data-state={st}
              onClick={() => void tap(t.id)}
              className={`flex min-h-[92px] flex-col items-start rounded-xl border p-3 text-left transition ${cardStyle(st)} ${interactive ? '' : 'cursor-not-allowed'}`}
            >
              <span className="line-clamp-2 text-sm font-medium">{t.title}</span>
              <span className="mt-auto pt-1 text-xs text-slate-500">
                {t.track} · {t.lecturerName ?? 'TBA'}
                {st === 'mine-locked' && ' · [LOCKED — decide below]'}
                {st === 'taken' && ' · TAKEN'}
                {st === 'locked' && !t.lockedByMe && ' · LOCKED'}
                {st === 'mine-taken' && ` · #${catalog?.mySelections.find((m) => m.thesisId === t.id)?.priority}`}
              </span>
            </button>
          );
        })}
        {cards.length === 0 && <p className="p-8 text-center text-slate-400 sm:col-span-2 lg:col-span-3">Choose a period via the lobby first.</p>}
      </div>

      {(catalog?.mySelections.filter((m) => m.status === 'confirmed').length ?? 0) > 1 && (
        <ReorderPanel periodId={periodId} onDone={load} />
      )}
    </div>
  );
}

function ReorderPanel({ periodId, onDone }: { periodId: string; onDone: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    void api<Catalog>(`/war/catalog?periodId=${periodId}`).then(setCatalog).catch(() => undefined);
  }, [periodId]);

  if (!catalog) return null;
  const confirmed = catalog.mySelections.filter((m) => m.status === 'confirmed');

  async function move(id: string, dir: -1 | 1): Promise<void> {
    const order = confirmed.map((c) => c.id);
    const idx = order.indexOf(id);
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= order.length) return;
    [order[idx], order[swapWith]] = [order[swapWith]!, order[idx]!];
    await api('/war/selections/order', { method: 'PATCH', body: { periodId, order } });
    const fresh = await api<Catalog>(`/war/catalog?periodId=${periodId}`);
    setCatalog(fresh);
    await onDone();
  }

  return (
    <section className="rounded-xl border bg-white p-4 text-sm shadow-sm">
      <h2 className="mb-2 font-medium">Priority order</h2>
      <ol className="flex flex-col gap-1">
        {confirmed.map((c, i) => (
          <li key={c.id} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
            <strong className="w-4">{i + 1}.</strong>
            <span className="flex-1 truncate">{c.title}</span>
            <button aria-label="move up" disabled={i === 0} onClick={() => void move(c.id, -1)} className="rounded border px-2 disabled:opacity-30">↑</button>
            <button aria-label="move down" disabled={i === confirmed.length - 1} onClick={() => void move(c.id, 1)} className="rounded border px-2 disabled:opacity-30">↓</button>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface Receipt {
  complete: boolean;
  count: number;
  required: number;
  selections: Array<{
    priority: number;
    title: string;
    lecturerName: string | null;
    referenceNumber: string | null;
    confirmedAt: string | null;
  }>;
}

export function ReceiptPage() {
  const [params] = useSearchParams();
  const periodId = params.get('period') ?? '';
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!periodId) return;
    void api<Receipt>(`/war/receipt?periodId=${periodId}`).then(async (r) => {
      setReceipt(r);
      const payload = JSON.stringify({
        period: periodId,
        refs: r.selections.map((s) => s.referenceNumber),
      });
      setQr(await QRCode.toDataURL(payload, { margin: 1, width: 180 }));
    });
  }, [periodId]);

  if (!receipt) return <main className="mx-auto max-w-md p-6"><p className="text-slate-500">Loading…</p></main>;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-lg font-semibold">Your selection{receipt.count === 1 ? '' : 's'}</h1>
        <p className="text-sm text-slate-500">
          {receipt.complete ? 'Complete — all titles claimed.' : `${receipt.count}/${receipt.required} claimed`}
        </p>
      </header>

      {qr && <img src={qr} alt="Verification QR code" className="self-center rounded-xl border bg-white p-2" />}

      <ol className="flex flex-col gap-2">
        {receipt.selections.map((s) => (
          <li key={s.priority} className="rounded-xl border bg-white p-3 text-sm shadow-sm">
            <div className="flex items-center justify-between">
              <strong>#{s.priority}</strong>
              <code className="text-xs text-slate-500">{s.referenceNumber}</code>
            </div>
            <p className="mt-0.5 font-medium">{s.title}</p>
            <p className="text-xs text-slate-500">
              {s.lecturerName ?? 'TBA'} ·{' '}
              {s.confirmedAt
                ? new Date(s.confirmedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' })
                : '—'}{' '}
              WIB
            </p>
          </li>
        ))}
        {receipt.selections.length === 0 && (
          <li className="rounded-xl border bg-white p-6 text-center text-slate-400">Nothing confirmed yet.</li>
        )}
      </ol>

      <p className="text-xs text-slate-500">
        Undo is available for a short window after each claim. Afterwards, changes go through a
        swap request to your lecturer.
      </p>
      <Link to={`/lobby?period=${periodId}`} className="text-center text-sm underline">Back to lobby</Link>
    </main>
  );
}
