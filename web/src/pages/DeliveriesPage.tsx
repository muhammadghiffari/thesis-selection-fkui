import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface DeliveryRow {
  studentId: string;
  npm: string;
  fullName: string;
  email: string;
  reminderStage: number;
  linkSentAt: string | null;
  linkOpenedAt: string | null;
  linkClaimedAt: string | null;
  deliveries: number;
  failed: number;
}

interface Period {
  id: string;
  name: string;
  status: string;
}

const STAGE_LABEL = ['—', 'H-7 sent', 'H-1 sent', 'H-1h sent', 'T-10 nudged'] as const;

function stateOf(r: DeliveryRow): { label: string; cls: string } {
  if (r.linkClaimedAt) return { label: 'claimed', cls: 'bg-emerald-100 text-emerald-700' };
  if (r.linkOpenedAt) return { label: 'opened', cls: 'bg-blue-100 text-blue-700' };
  if (r.linkSentAt) return { label: 'sent', cls: 'bg-amber-100 text-amber-800' };
  return { label: 'pending', cls: 'bg-slate-100 text-slate-600' };
}

export function DeliveriesPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    void api<Period[]>('/admin/periods').then(setPeriods);
  }, []);

  const load = useCallback(async () => {
    if (!periodId) return setRows([]);
    setRows(await api<DeliveryRow[]>(`/admin/periods/${periodId}/enrollments`));
  }, [periodId]);
  useEffect(() => void load(), [load]);

  async function resend(studentId: string): Promise<void> {
    if (!window.confirm('Issue a fresh magic link to this student? Old links become invalid.')) return;
    try {
      await api(`/admin/students/${studentId}/resend-link`, { method: 'POST', body: { periodId } });
      setBanner('Fresh link sent');
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  async function runStage(stage: string): Promise<void> {
    if (!window.confirm(`Run stage ${stage} now? Exactly-once guards apply.`)) return;
    try {
      const res = await api<{ sent: number }>(`/admin/periods/${periodId}/run-stage`, {
        method: 'POST',
        body: { stage },
      });
      setBanner(`Stage ${stage}: ${res.sent} sent`);
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Magic Link Deliveries</h1>
        <div className="flex flex-wrap gap-2 text-xs">
          {['initial_h7', 'reminder_h1', 'reminder_h1h', 'nudge_t10', 'closes_warning'].map((stage) => (
            <button
              key={stage}
              disabled={!periodId}
              onClick={() => void runStage(stage)}
              className="rounded-lg border px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
            >
              run {stage}
            </button>
          ))}
        </div>
      </header>

      <label className="text-sm text-slate-600 sm:max-w-xs">
        Period
        <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2">
          <option value="">— choose —</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.status})</option>
          ))}
        </select>
      </label>

      {banner && <p role="status" className="rounded-lg bg-slate-100 px-3 py-2 text-sm">{banner}</p>}

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr><th>NPM</th><th>Name</th><th>Email</th><th>State</th><th>Last stage</th><th>Sent</th><th>Opened</th><th>Failed</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = stateOf(r);
              return (
                <tr key={r.studentId} className="border-t">
                  <td className="px-3 py-2">{r.npm}</td>
                  <td className="px-3 py-2">{r.fullName}</td>
                  <td className="px-3 py-2 text-xs">{r.email}</td>
                  <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span></td>
                  <td className="px-3 py-2 text-xs">{STAGE_LABEL[r.reminderStage] ?? r.reminderStage}</td>
                  <td className="px-3 py-2 text-xs">{fmt(r.linkSentAt)}</td>
                  <td className="px-3 py-2 text-xs">{fmt(r.linkOpenedAt)}</td>
                  <td className={`px-3 py-2 text-xs ${r.failed > 0 ? 'font-medium text-red-600' : ''}`}>{r.failed}</td>
                  <td className="px-3 py-2">
                    {!r.linkClaimedAt && (
                      <button onClick={() => void resend(r.studentId)} className="rounded border px-2 py-1 text-xs hover:bg-slate-100">
                        Resend
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">{periodId ? 'No enrollments yet — run the H-7 stage' : 'Choose a period'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });
}
