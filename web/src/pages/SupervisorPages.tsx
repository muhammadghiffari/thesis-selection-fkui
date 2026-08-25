import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { connectRealtime, joinLobby, onCardUpdate } from '../lib/realtime';

interface Catalog {
  mySelections: Array<{ id: string; status: string }>;
  required: number;
  theses: Array<{
    id: string;
    title: string;
    track: string;
    lecturerName: string | null;
    status: 'available' | 'locked' | 'taken';
  }>;
}

/** Admin live monitor: full grid via lobby socket + rolling claims/min stat. */
export function AdminMonitorPage() {
  const [params] = useSearchParams();
  const periodId = params.get('period') ?? '';
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [periods, setPeriods] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [claimsPerMin, setClaimsPerMin] = useState(0);
  const eventTimes = useRef<number[]>([]);

  useEffect(() => {
    void api<Array<{ id: string; name: string; status: string }>>('/admin/periods').then(setPeriods);
  }, []);

  const load = useCallback(async () => {
    if (!periodId) return;
    setCatalog(await api<Catalog>(`/war/catalog?periodId=${periodId}`));
  }, [periodId]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!periodId) return;
    const sock = connectRealtime();
    if (sock) joinLobby(periodId);
    const off = onCardUpdate((u) => {
      if (u.periodId !== periodId) return;
      eventTimes.current.push(Date.now());
      setCatalog((prev) =>
        prev
          ? {
              ...prev,
              theses: prev.theses.map((t) =>
                t.id === u.thesisId
                  ? { ...t, status: u.status as Catalog['theses'][number]['status'] }
                  : t,
              ),
            }
          : prev,
      );
    });
    return () => {
      off();
    };
  }, [periodId]);

  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      eventTimes.current = eventTimes.current.filter((x) => x > cutoff);
      setClaimsPerMin(eventTimes.current.length);
    }, 2000);
    return () => clearInterval(t);
  }, []);

  const taken = catalog?.theses.filter((t) => t.status === 'taken').length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Live monitor</h1>
        <select value={periodId} onChange={(e) => window.location.search = `?period=${e.target.value}`}
          className="rounded-lg border px-3 py-2 text-sm" aria-label="choose period">
          <option value="">— choose —</option>
          {periods.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.status})</option>)}
        </select>
      </header>

      {catalog && (
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="Titles taken" value={`${taken}/${catalog.theses.length}`} />
          <Stat
            label="Completion rate"
            value={`${
              Math.round(
                (catalog.mySelections.reduce((a, m) => a + (m.status === 'confirmed' || m.status === 'taken' ? 1 : 0), 0) /
                  Math.max(1, catalog.required)) *
                  100,
              )
            }% avg of ${catalog.required}/3`}
          />
          <Stat label="Claims / min (live)" value={String(claimsPerMin)} pulse={claimsPerMin > 0} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(catalog?.theses ?? []).map((t) => (
          <div key={t.id}
            className={`rounded-xl border p-3 text-xs ${
              t.status === 'available' ? 'border-emerald-300 bg-emerald-50'
              : t.status === 'locked' ? 'border-slate-400 bg-slate-100 animate-pulse'
              : 'border-slate-200 bg-slate-50 opacity-50'
            }`}>
            <p className="line-clamp-2 font-medium">{t.title}</p>
            <p className="mt-1 text-slate-500">{t.status.toUpperCase()}</p>
          </div>
        ))}
        {!catalog && <p className="text-slate-400 sm:col-span-2 lg:col-span-4">Choose a period.</p>}
      </div>
    </div>
  );
}

function Stat({ label, value, pulse }: { label: string; value: string; pulse?: boolean }) {
  return (
    <div className={`rounded-xl border bg-white p-3 shadow-sm ${pulse ? 'ring-2 ring-emerald-300' : ''}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

interface IntegrityRow {
  id: string;
  score: number;
  level: 'high' | 'medium';
  signals: { rules?: Array<{ rule: string; points: number; evidence: Record<string, unknown> }> };
  selectionId: string;
  selectionStatus: string;
  title: string;
  studentName: string;
  npm: string;
}

/** Shared integrity queue — admin sees all; lecturer variant hits scoped endpoint. */
export function IntegrityQueuePage({ scope }: { scope: 'admin' | 'lecturer' }) {
  const base = scope === 'admin' ? '/admin/integrity' : '/lecturer/integrity';
  const [level, setLevel] = useState('');
  const [rows, setRows] = useState<IntegrityRow[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setRows(await api<IntegrityRow[]>(`${base}?${level ? `level=${level}&` : ''}pageSize=100`));
  }, [base, level]);
  useEffect(() => void load(), [load]);

  async function resolve(id: string, outcome: string): Promise<void> {
    const note = notes[id]?.trim() ?? '';
    if (note.length < 3) return setBanner('A written note is mandatory.');
    try {
      await api(`${base}/${id}/resolve`, { method: 'POST', body: { outcome, note } });
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Integrity queue</h1>
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" aria-label="filter level">
          <option value="">All levels</option>
          <option value="high">HIGH</option>
          <option value="medium">MEDIUM</option>
        </select>
      </header>
      {banner && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm">{banner}</p>}
      {rows.map((r) => (
        <div key={r.id} className={`rounded-xl border p-4 text-sm shadow-sm ${r.level === 'high' ? 'border-red-300' : 'border-amber-200'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{r.title}</strong>
            <span className={`rounded-full px-2 py-0.5 text-xs ${r.level === 'high' ? 'bg-red-600 text-white' : 'bg-amber-300'}`}>
              {r.level.toUpperCase()} · score {r.score}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600">{r.studentName} ({r.npm}) · status {r.selectionStatus}</p>
          <ul className="mt-2 list-disc pl-5 text-xs text-slate-700">
            {(r.signals?.rules ?? []).map((rule) => (
              <li key={rule.rule}>
                {rule.rule} (+{rule.points})
                <span className="ml-1 text-slate-400">{JSON.stringify(rule.evidence)}</span>
              </li>
            ))}
          </ul>
          <textarea
            rows={2}
            placeholder="Resolution note (mandatory)…"
            value={notes[r.id] ?? ''}
            onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
            className="mt-2 w-full rounded-lg border p-2 text-xs"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {(['false_positive', 'investigate', 'revoked'] as const).map((outcome) => (
              <button
                key={outcome}
                disabled={(notes[r.id]?.trim().length ?? 0) < 3}
                onClick={() => void resolve(r.id, outcome)}
                className={`rounded-lg px-3 py-1.5 text-xs disabled:opacity-40 ${
                  outcome === 'revoked' ? 'bg-red-600 text-white' : 'border'
                }`}
              >
                {outcome.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-slate-400">Queue empty for this filter.</p>}
    </div>
  );
}

interface AuditRow {
  id: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  createdAt: string;
}

/** Read-only audit trail viewer with filters + pagination. */
export function AuditViewerPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');

  const load = useCallback(async () => {
    const q = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (action) q.set('action', action);
    if (from) q.set('from', new Date(from).toISOString());
    const res = await api<{ rows: AuditRow[]; total: number }>(`/admin/audit?${q}`);
    setRows(res.rows);
    setTotal(res.total);
  }, [page, action, from]);
  useEffect(() => void load(), [load]);

  function exportCsv(): void {
    const header = 'id,actorRole,action,entityType,createdAt\n';
    const body = rows
      .map((r) => `${r.id},${r.actorRole ?? ''},${r.action},${r.entityType},${r.createdAt}`)
      .join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-page-${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    void QRCode; // keep import graph honest if tree-shaken
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Audit log</h1>
        <button onClick={exportCsv} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-100">Export CSV</button>
      </header>

      <div className="flex flex-wrap gap-2 text-sm">
        <input placeholder="Filter action…" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
          className="w-full max-w-[200px] rounded-lg border px-3 py-2 sm:w-auto" />
        <label className="text-xs text-slate-600">From
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }}
            className="ml-1 rounded-lg border px-2 py-1.5" />
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="bg-slate-50 text-left text-slate-600"><tr><th>When (WIB)</th><th>Actor role</th><th>Action</th><th>Entity</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-1.5">{new Date(r.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</td>
                <td className="px-3 py-1.5">{r.actorRole ?? 'system'}</td>
                <td className="px-3 py-1.5 font-medium">{r.action}</td>
                <td className="px-3 py-1.5">{r.entityType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between text-sm text-slate-600">
        <span>{total} entries</span>
        <span className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-3 py-1 disabled:opacity-40">Prev</button>
          <span className="px-2 py-1">{page}</span>
          <button disabled={page * 25 >= total} onClick={() => setPage(page + 1)} className="rounded border px-3 py-1 disabled:opacity-40">Next</button>
        </span>
      </footer>
    </div>
  );
}
