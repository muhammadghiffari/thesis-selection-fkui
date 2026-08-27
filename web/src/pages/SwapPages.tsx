import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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

interface Catalog {
  mySelections: Array<{
    id: string;
    thesisId: string;
    priority: number;
    status: string;
    title: string;
  }>;
}

/** Student view: own requests with live status + cancel while pending. */
export function MySwapsPage() {
  const [params] = useSearchParams();
  const periodId = params.get('period');
  const [rows, setRows] = useState<SwapRow[]>([]);
  const [selections, setSelections] = useState<Catalog['mySelections']>([]);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await api<SwapRow[]>('/swaps/mine'));
    if (periodId) {
      const cat = await api<Catalog>(`/war/catalog?periodId=${periodId}`);
      setSelections(cat.mySelections.filter(m => m.status === 'confirmed' || m.status === 'taken'));
    }
  }, [periodId]);
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4 sm:p-6">
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
      {rows.length === 0 && <p className="text-sm text-slate-400">No active swap requests.</p>}
      
      <section className="mt-4 rounded-xl border bg-slate-50 p-4 shadow-sm">
        <h2 className="mb-2 font-medium">Request a new swap</h2>
        <form onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fd = new FormData(form);
          try {
            await api('/swaps', { method: 'POST', body: {
              selectionId: fd.get('selectionId'),
              category: fd.get('category'),
              reasonDetail: fd.get('reasonDetail'),
            }});
            form.reset();
            await load();
          } catch (err) {
            setBanner(err instanceof Error ? err.message : String(err));
          }
        }} className="flex flex-col gap-3 text-sm">
          <select name="selectionId" required className="rounded border px-3 py-2 bg-white">
            <option value="">Select a confirmed thesis to swap...</option>
            {selections.map(s => <option key={s.id} value={s.id}>#{s.priority} - {s.title}</option>)}
          </select>
          <select name="category" required className="rounded border px-3 py-2 bg-white">
            <option value="">Select category...</option>
            <option value="schedule_conflict">Schedule Conflict</option>
            <option value="health_issue">Health Issue</option>
            <option value="research_mismatch">Research Mismatch</option>
            <option value="other">Other</option>
          </select>
          <textarea name="reasonDetail" placeholder="Reason details (min 20 chars)..." required minLength={20} className="rounded border px-3 py-2" rows={3}></textarea>
          <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-white">Submit Request</button>
        </form>
      </section>
      
      {periodId && (
        <div className="mt-2 text-center text-sm">
          <Link to={`/receipt?period=${periodId}`} className="underline text-slate-500">Back to Receipt</Link>
        </div>
      )}
    </main>
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
