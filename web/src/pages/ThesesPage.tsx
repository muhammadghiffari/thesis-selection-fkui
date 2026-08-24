import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiDownload, apiUpload } from '../lib/api';

interface ThesisRow {
  id: string;
  title: string;
  track: string;
  lecturerName: string | null;
  maxClaims: number;
}

interface ThesisImportRow {
  line: number;
  data: Record<string, unknown>;
  errors: Record<string, string>;
}

export function ThesesPage() {
  const [periods, setPeriods] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [periodId, setPeriodId] = useState('');
  const [data, setData] = useState<{ rows: ThesisRow[]; total: number }>({ rows: [], total: 0 });
  const [banner, setBanner] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rows: ThesisImportRow[]; total: number; valid: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<Array<{ id: string; name: string; status: string }>>('/admin/periods').then(setPeriods);
  }, []);

  const load = useCallback(async () => {
    if (!periodId) return setData({ rows: [], total: 0 });
    setData(await api(`/admin/theses?periodId=${periodId}&pageSize=50`));
  }, [periodId]);
  useEffect(() => void load(), [load]);

  async function onFile(file: File): Promise<void> {
    if (!periodId) return setBanner('Pick a period first');
    try {
      setPreview(await apiUpload(`/admin/theses/import/preview?periodId=${periodId}`, file));
    } catch (err) {
      setBanner(`Import rejected: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function commit(): Promise<void> {
    if (!preview) return;
    const rows = preview.rows
      .filter((r) => Object.keys(r.errors).length === 0)
      .map((r) => ({
        title: String(r.data.title),
        track: String(r.data.track),
        lecturerFullName: String(r.data.lecturer_full_name ?? r.data.lecturerFullName ?? ''),
        maxClaims: Number(r.data.max_claims ?? r.data.maxClaims ?? 1),
      }));
    try {
      const res = await api<{ inserted: unknown[]; skipped: unknown[] }>('/admin/theses/import/commit', {
        method: 'POST',
        body: { periodId, rows },
      });
      setBanner(`Imported ${res.inserted.length}, skipped ${res.skipped.length}`);
      setPreview(null);
      await load();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Thesis Catalog</h1>
        <div className="flex gap-2">
          <button
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void onFile(f);
            }}
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-dashed px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            Import .xlsx/.csv
            <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.currentTarget.value = ''; }} />
          </button>
          <button
            disabled={!periodId}
            onClick={() => periodId && void apiDownload(`/admin/theses/export.xlsx?periodId=${periodId}`, 'theses.xlsx')}
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40"
          >
            Export .xlsx
          </button>
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

      {banner && (
        <p role="status" className="rounded-lg bg-slate-100 px-3 py-2 text-sm">{banner}</p>
      )}

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-600"><tr><th>Title</th><th>Track</th><th>Lecturer</th><th>Max claims</th></tr></thead>
          <tbody>
            {data.rows.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-3 py-2">{t.title}</td>
                <td className="px-3 py-2">{t.track}</td>
                <td className="px-3 py-2">{t.lecturerName ?? '—'}</td>
                <td className="px-3 py-2">{t.maxClaims}</td>
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400">{periodId ? 'No theses in this period' : 'Choose a period'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {preview && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 sm:items-center" role="dialog" aria-label="thesis import preview">
          <div className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-semibold">Preview — {preview.total} rows, {preview.valid} valid</h2>
              <button onClick={() => setPreview(null)} aria-label="close" className="text-slate-500">✕</button>
            </header>
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-xs">
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line} className={`border-t ${Object.keys(r.errors).length ? 'bg-red-50/60' : ''}`}>
                      <td className="px-2 py-1">{r.line}</td>
                      <td className="px-2 py-1">{String(r.data.title)}</td>
                      <td className="px-2 py-1">{String(r.data.track)}</td>
                      <td className="px-2 py-1">{String(r.data.lecturer_full_name)}</td>
                      <td className="px-2 py-1">
                        {Object.keys(r.errors).length
                          ? <span className="text-red-600">⚠ {Object.values(r.errors)[0]}</span>
                          : <span className="text-emerald-600">✓</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="flex justify-end gap-2 border-t px-4 py-3">
              <button onClick={() => setPreview(null)} className="rounded-lg border px-4 py-2">Cancel</button>
              <button onClick={() => void commit()} className="rounded-lg bg-slate-900 px-4 py-2 text-white">Commit {preview.valid} rows</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
