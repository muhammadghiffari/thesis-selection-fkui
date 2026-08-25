import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface OwnThesis {
  thesisId: string;
  title: string;
  track: string;
  holderName: string | null;
  holderNpm: string | null;
  selectionStatus: string | null;
  priority: number | null;
  confirmedAt: string | null;
  referenceNumber: string | null;
  attemptsLeft: number | null;
  highAlerts: number;
}

interface Alert {
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

const RULE_LABEL: Record<string, string> = {
  track_mismatch: 'Track mismatch (+25)',
  duplicate_device: 'Duplicate device (+25)',
  ip_sharing: 'IP sharing (+20)',
  fast_confirm: 'Lock→confirm <2s (+15)',
  preopen_attempt: 'Pre-open access attempt (+15)',
  rebind_attempt: 'Link opened on other device (+20)',
};

export function LecturerDashboardPage() {
  const [theses, setTheses] = useState<OwnThesis[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setTheses(await api<OwnThesis[]>('/lecturer/theses'));
    setAlerts(await api<Alert[]>('/lecturer/integrity?pageSize=50'));
  }, []);
  useEffect(() => void load(), [load]);

  async function resolve(flagId: string, outcome: string): Promise<void> {
    const note = notes[flagId]?.trim() ?? '';
    if (note.length < 3) return setBanner('A written note is mandatory.');
    try {
      await api(`/lecturer/integrity/${flagId}/resolve`, { method: 'POST', body: { outcome, note } });
      setNotes((n) => ({ ...n, [flagId]: '' }));
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  async function revoke(selectionId: string): Promise<void> {
    if (!window.confirm('Revoke this selection? Title becomes available; student gets an extra attempt.')) return;
    try {
      await api('/admin/swaps/revoke', {
        method: 'POST',
        body: { selectionId, reason: notes['rev:' + selectionId]?.trim() || 'Revoked after supervisor review.' },
      });
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold">My theses</h1>
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr><th>Title</th><th>Holder</th><th>Status</th><th>Ref</th><th>Attempts</th><th>Alerts</th></tr>
            </thead>
            <tbody>
              {theses.map((t) => (
                <tr key={t.thesisId} className="border-t">
                  <td className="px-3 py-2">{t.title}</td>
                  <td className="px-3 py-2">{t.holderName ? `${t.holderName} (${t.holderNpm})` : '—'}</td>
                  <td className="px-3 py-2 text-xs">{t.selectionStatus ?? 'unclaimed'}</td>
                  <td className="px-3 py-2 text-xs">{t.referenceNumber ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{t.attemptsLeft ?? '—'}</td>
                  <td className={`px-3 py-2 text-xs ${t.highAlerts > 0 ? 'font-medium text-red-600' : ''}`}>
                    {t.highAlerts > 0 ? `${t.highAlerts} HIGH` : '—'}
                  </td>
                </tr>
              ))}
              {theses.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">No theses assigned to your account yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {banner && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">{banner}</p>}

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Integrity alerts</h2>
        {alerts.map((a) => {
          const rules = a.signals?.rules ?? [];
          return (
            <div key={a.id} className={`rounded-xl border p-4 text-sm shadow-sm ${a.level === 'high' ? 'border-red-300 bg-red-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{a.title}</strong>
                <span className={`rounded-full px-2 py-0.5 text-xs ${a.level === 'high' ? 'bg-red-600 text-white' : 'bg-amber-400 text-amber-900'}`}>
                  {a.level.toUpperCase()} · {a.score}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600">
                {a.studentName} ({a.npm}) · status {a.selectionStatus}
              </p>
              <ul className="mt-2 list-disc pl-5 text-xs text-slate-700">
                {rules.map((r) => (
                  <li key={r.rule}>
                    {RULE_LABEL[r.rule] ?? r.rule}
                    <span className="ml-1 text-slate-400">({JSON.stringify(r.evidence)})</span>
                  </li>
                ))}
              </ul>
              <textarea
                rows={2}
                placeholder="Resolution note (mandatory)…"
                value={notes[a.id] ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                className="mt-2 w-full rounded-lg border p-2 text-xs"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button disabled={(notes[a.id]?.trim().length ?? 0) < 3} onClick={() => void resolve(a.id, 'false_positive')}
                  className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40">False positive</button>
                <button disabled={(notes[a.id]?.trim().length ?? 0) < 3} onClick={() => void resolve(a.id, 'investigate')}
                  className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40">Investigate</button>
                <button
                  data-testid={`revoke-${a.selectionId}`}
                  onClick={() => void revoke(a.selectionId)}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white"
                >
                  Revoke now (F7 flow)
                </button>
                <button disabled={(notes[a.id]?.trim().length ?? 0) < 3} onClick={() => void resolve(a.id, 'revoked')}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40">
                  Resolve as revoked (audited)
                </button>
              </div>
            </div>
          );
        })}
        {alerts.length === 0 && <p className="text-sm text-slate-400">No integrity alerts for your theses.</p>}
      </section>
    </div>
  );
}
