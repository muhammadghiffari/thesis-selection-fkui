import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface SwapRow {
  id: string;
  category: string;
  reasonDetail: string;
  status: string;
  decisionNote?: string | null;
  requestedAt: string;
  studentName?: string;
  npm?: string;
  title?: string;
}

/** Student view: own requests with live status + cancel while pending. */
export function MySwapsPage() {
  const [rows, setRows] = useState<SwapRow[]>([]);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await api<SwapRow[]>('/swaps/mine'));
  }, []);
  useEffect(() => void load(), [load]);

  async function cancel(id: string): Promise<void> {
    if (!window.confirm('Cancel this swap request?')) return;
    try {
      await api(`/swaps/${id}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">My swap requests</h1>
      {banner && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm">{banner}</p>}
      {rows.map((r) => (
        <div key={r.id} className="rounded-xl border bg-white p-3 text-sm shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{r.title ?? r.id}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                r.status === 'pending'
                  ? 'bg-yellow-100 text-yellow-800'
                  : r.status === 'approved'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-slate-100'
              }`}
            >
              {r.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {r.category} · {r.reasonDetail}
          </p>
          {r.decisionNote && <p className="mt-1 text-xs italic text-slate-600">“{r.decisionNote}”</p>}
          {r.status === 'pending' && (
            <button onClick={() => void cancel(r.id)} className="mt-2 rounded border px-2 py-1 text-xs hover:bg-slate-50">
              Cancel request
            </button>
          )}
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-slate-400">No swap requests yet.</p>}
    </div>
  );
}

/** Lecturer/Admin review queue — mandatory decision note. */
export function SwapReviewPage() {
  const [rows, setRows] = useState<SwapRow[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await api<SwapRow[]>('/admin/swaps/queue'));
  }, []);
  useEffect(() => void load(), [load]);

  async function decide(id: string, decision: 'approve' | 'reject'): Promise<void> {
    const note = notes[id]?.trim() ?? '';
    if (note.length < 3) {
      setBanner('A written decision note is mandatory.');
      return;
    }
    try {
      await api(`/admin/swaps/${id}/decision`, { method: 'PATCH', body: { decision, note } });
      setNotes((n) => ({ ...n, [id]: '' }));
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Swap requests awaiting review</h1>
      {banner && <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm">{banner}</p>}
      {rows.map((r) => (
        <div key={r.id} className="rounded-xl border bg-white p-4 text-sm shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <strong>{r.title}</strong>
            <span className="text-xs text-slate-500">
              {r.studentName} ({r.npm}) · {r.category}
            </span>
          </div>
          <p className="mt-1 text-slate-700">{r.reasonDetail}</p>
          <textarea
            rows={2}
            placeholder="Decision note (mandatory)…"
            value={notes[r.id] ?? ''}
            onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
            className="mt-2 w-full rounded-lg border p-2 text-xs"
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void decide(r.id, 'approve')}
              disabled={(notes[r.id]?.trim().length ?? 0) < 3}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-40"
            >
              Approve → 60s grace
            </button>
            <button
              onClick={() => void decide(r.id, 'reject')}
              disabled={(notes[r.id]?.trim().length ?? 0) < 3}
              className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-slate-400">Queue is empty.</p>}
    </div>
  );
}
