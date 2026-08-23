import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Period {
  id: string;
  name: string;
  academicYear: string;
  status: 'draft' | 'scheduled' | 'open' | 'closed' | 'archived';
  opensAt: string | null;
  closesAt: string | null;
  settings: Record<string, number | string>;
}

const NEXT: Record<Period['status'], string | null> = {
  draft: 'scheduled',
  scheduled: 'open',
  open: 'closed',
  closed: 'archived',
  archived: null,
};

const STATUS_STYLE: Record<Period['status'], string> = {
  draft: 'bg-slate-100 text-slate-700',
  scheduled: 'bg-amber-100 text-amber-800',
  open: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-blue-100 text-blue-700',
  archived: 'bg-gray-200 text-gray-500',
};

export function PeriodsPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', academicYear: '', opensAt: '', closesAt: '' });

  const load = useCallback(async () => {
    setPeriods(await api<Period[]>('/admin/periods'));
  }, []);
  useEffect(() => void load(), [load]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await api('/admin/periods', { method: 'POST', body: form });
      setCreating(false);
      setForm({ name: '', academicYear: '', opensAt: '', closesAt: '' });
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  async function transition(p: Period): Promise<void> {
    const to = NEXT[p.status];
    if (!to || !window.confirm(`Move '${p.name}' to ${to}?`)) return;
    try {
      await api(`/admin/periods/${p.id}/transition`, { method: 'POST', body: { to } });
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  async function clone(p: Period): Promise<void> {
    if (!window.confirm(`Clone config of '${p.name}' into a new draft?`)) return;
    try {
      const cloned = await api<Period>(`/admin/periods/${p.id}/clone`, { method: 'POST' });
      setBanner(`Cloned as '${cloned.name}' (draft — dates cleared)`);
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(p: Period): Promise<void> {
    if (!window.confirm(`Delete draft '${p.name}'?`)) return;
    try {
      await api(`/admin/periods/${p.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Selection Periods</h1>
        <button onClick={() => setCreating(!creating)} className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white">
          New period
        </button>
      </header>

      {banner && (
        <p role="status" className="rounded-lg bg-slate-100 px-3 py-2 text-sm">
          {banner}
          <button className="ml-2 underline" onClick={() => setBanner(null)}>dismiss</button>
        </p>
      )}

      {creating && (
        <form onSubmit={create} className="grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2">
          <input required minLength={3} placeholder="Name (e.g. Seleksi TA 2027)" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-lg border px-3 py-2" />
          <input required minLength={4} placeholder="Academic year (e.g. 2026/2027)" value={form.academicYear}
            onChange={(e) => setForm({ ...form, academicYear: e.target.value })} className="rounded-lg border px-3 py-2" />
          <label className="text-sm text-slate-600">Opens at
            <input type="datetime-local" value={form.opensAt} onChange={(e) => setForm({ ...form, opensAt: e.target.value })}
              className="mt-1 w-full rounded-lg border px-3 py-2" />
          </label>
          <label className="text-sm text-slate-600">Closes at
            <input type="datetime-local" value={form.closesAt} onChange={(e) => setForm({ ...form, closesAt: e.target.value })}
              className="mt-1 w-full rounded-lg border px-3 py-2" />
          </label>
          <div className="sm:col-span-2">
            <button className="rounded-lg bg-slate-900 px-4 py-2 text-white">Create draft period</button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr><th>Name</th><th>Year</th><th>Status</th><th>Opens</th><th>Closes</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-3 py-2 font-medium">{p.name}</td>
                <td className="px-3 py-2">{p.academicYear}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[p.status]}`}>{p.status}</span></td>
                <td className="px-3 py-2 text-xs">{fmtDate(p.opensAt)}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(p.closesAt)}</td>
                <td className="flex flex-wrap gap-1 px-3 py-2 text-xs">
                  {NEXT[p.status] && <button onClick={() => void transition(p)} className="rounded border px-2 py-1 hover:bg-slate-100">→ {NEXT[p.status]}</button>}
                  <button onClick={() => void clone(p)} className="rounded border px-2 py-1 hover:bg-slate-100">Clone</button>
                  {p.status === 'draft' && <button onClick={() => void remove(p)} className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50">Delete</button>}
                </td>
              </tr>
            ))}
            {periods.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">No periods yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
}
