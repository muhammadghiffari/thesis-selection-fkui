import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { api, apiDownload, apiUpload } from '../lib/api';

interface StudentRow {
  id: string;
  npm: string;
  fullName: string;
  email: string;
  classType: string;
  researchTrack: string;
}

interface ListResponse {
  rows: StudentRow[];
  total: number;
}

interface ImportState {
  rows: Array<{
    line: number;
    data: Record<string, string>;
    errors: Record<string, string>;
    excluded: boolean;
  }>;
  total: number;
  valid: number;
}

const columnHelper = createColumnHelper<StudentRow>();
const PAGE_SIZE = 10;

export function StudentsPage() {
  const [data, setData] = useState<ListResponse>({ rows: [], total: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [classType, setClassType] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set('search', search);
    if (classType) params.set('classType', classType);
    setData(await api<ListResponse>(`/admin/students?${params}`));
  }, [page, search, classType]);

  useEffect(() => void load(), [load]);
  useEffect(() => setSelected(new Set()), [data]);

  async function bulk(action: string, extra?: Record<string, unknown>): Promise<void> {
    const label: Record<string, string> = {
      assign_slots: `Assign ${extra?.attempts ?? 4} attempt slots`,
      send_magic_links: 'Queue magic-link sends',
      reset_attempts: 'Reset attempts to default',
      deactivate: 'Deactivate selected accounts',
    };
    if (!window.confirm(`${label[action]} — ${selected.size} student(s)?`)) return;
    try {
      const res = await api<{ affected: number }>('/admin/students/bulk', {
        method: 'POST',
        body: { action, studentIds: [...selected], periodId: extra?.periodId, attempts: extra?.attempts },
      });
      setBanner(`${label[action]}: ${res.affected} affected`);
      await load();
    } catch (err) {
      setBanner(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function onFile(file: File): Promise<void> {
    setBanner(null);
    try {
      const res = await apiUpload<ImportState>('/admin/students/import/preview', file);
      setImportState({ ...res, rows: res.rows.map((r) => ({ ...r, excluded: false })) });
    } catch (err) {
      setBanner(`Import rejected: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function commitImport(): Promise<void> {
    if (!importState) return;
    const payload = importState.rows
      .filter((r) => !r.excluded)
      .map((r) => ({
        npm: r.data.npm,
        fullName: r.data.fullName ?? r.data.full_name,
        email: r.data.email,
        classType: r.data.classType ?? r.data.class_type,
        researchTrack: r.data.researchTrack ?? r.data.research_track,
      }));
    try {
      const res = await api<{ inserted: unknown[]; skipped: unknown[] }>('/admin/students/import/commit', {
        method: 'POST',
        body: { rows: payload },
      });
      setBanner(`Imported ${res.inserted.length}, skipped ${res.skipped.length}`);
      setImportState(null);
      setPage(1);
      await load();
    } catch (err) {
      setBanner(`Commit failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            aria-label="select all"
            checked={data.rows.length > 0 && selected.size === data.rows.length}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(data.rows.map((r) => r.id)) : new Set())
            }
          />
        ),
        cell: (ctx) => (
          <input
            type="checkbox"
            aria-label={`select ${ctx.row.original.npm}`}
            checked={selected.has(ctx.row.original.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(ctx.row.original.id);
              else next.delete(ctx.row.original.id);
              setSelected(next);
            }}
          />
        ),
      }),
      columnHelper.accessor('npm', { header: 'NPM' }),
      columnHelper.accessor('fullName', { header: 'Name' }),
      columnHelper.accessor('email', { header: 'Email' }),
      columnHelper.accessor('classType', { header: 'Class' }),
      columnHelper.accessor('researchTrack', { header: 'Track' }),
    ],
    [data.rows, selected],
  );

  const table = useReactTable({
    data: data.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Students</h1>
        <div className="flex gap-2">
          <ImportDropzone onFile={onFile} />
          <button
            onClick={() => {
              const params = new URLSearchParams();
              if (search) params.set('search', search);
              if (classType) params.set('classType', classType);
              void apiDownload(`/admin/students/export.xlsx?${params}`, 'students.xlsx');
            }}
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            Export .xlsx
          </button>
        </div>
      </header>

      {banner && (
        <p role="status" className="rounded-lg bg-slate-100 px-3 py-2 text-sm">
          {banner}
          <button className="ml-2 underline" onClick={() => setBanner(null)}>dismiss</button>
        </p>
      )}

      <div className="flex flex-wrap gap-2 text-sm">
        <input
          placeholder="Search name/NPM/email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="w-full max-w-xs rounded-lg border px-3 py-2 sm:w-auto"
        />
        <select
          value={classType}
          onChange={(e) => {
            setClassType(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border px-3 py-2"
          aria-label="filter by class"
        >
          <option value="">All classes</option>
          <option value="regular">Regular</option>
          <option value="kki">KKI</option>
        </select>
      </div>

      {selected.size > 0 && (
        <BulkBar count={selected.size} onAction={bulk} onClear={() => setSelected(new Set())} />
      )}

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} className="px-3 py-2 font-medium">
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-t hover:bg-slate-50/60">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">No students found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between text-sm text-slate-600">
        <span>{data.total} total</span>
        <span className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-3 py-1 disabled:opacity-40">Prev</button>
          <span className="px-2 py-1">{page}/{totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded border px-3 py-1 disabled:opacity-40">Next</button>
        </span>
      </footer>

      {importState && (
        <ImportPreview state={importState} onChange={setImportState} onCancel={() => setImportState(null)} onCommit={commitImport} />
      )}
    </div>
  );
}

function ImportDropzone({ onFile }: { onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <button
      ref={ref as never}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      onClick={() => ref.current && (ref.current as HTMLInputElement).click?.()}
      className={`rounded-lg border border-dashed px-3 py-1.5 text-sm ${over ? 'bg-blue-50 border-blue-400' : 'hover:bg-slate-100'}`}
    >
      Import .xlsx/.csv
      <input
        type="file"
        accept=".xlsx,.csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.currentTarget.value = '';
        }}
      />
    </button>
  );
}

function BulkBar({
  count,
  onAction,
  onClear,
}: {
  count: number;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  onClear: () => void;
}) {
  const [attempts, setAttempts] = useState(4);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
      <strong>{count}</strong> selected
      <label className="ml-2">
        slots
        <input
          type="number"
          min={0}
          value={attempts}
          onChange={(e) => setAttempts(Number(e.target.value))}
          className="ml-1 w-16 rounded border px-2 py-1"
        />
      </label>
      <button onClick={() => onAction('assign_slots', { attempts })} className="rounded-lg border bg-white px-3 py-1.5">Assign slots</button>
      <button onClick={() => onAction('reset_attempts')} className="rounded-lg border bg-white px-3 py-1.5">Reset attempts</button>
      <button onClick={() => onAction('send_magic_links')} className="rounded-lg border bg-white px-3 py-1.5">Send magic links</button>
      <button onClick={() => onAction('deactivate')} className="rounded-lg border bg-red-100 px-3 py-1.5 text-red-700">Deactivate</button>
      <button onClick={onClear} className="ml-auto underline">clear</button>
    </div>
  );
}

function ImportPreview({
  state,
  onChange,
  onCancel,
  onCommit,
}: {
  state: ImportState;
  onChange: (s: ImportState) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const validCount = state.rows.filter((r) => !r.excluded && Object.keys(r.errors).length === 0).length;

  function editField(idx: number, field: string, value: string): void {
    const rows = [...state.rows];
    const row = { ...rows[idx]!, data: { ...rows[idx]!.data, [field]: value } };
    // editing clears that field's error; server re-validates at commit
    const errors = { ...row.errors };
    delete errors[field];
    rows[idx] = { ...row, errors };
    onChange({ ...state, rows });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-6" role="dialog" aria-label="import preview">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold">Preview — {state.total} rows, {validCount} valid</h2>
          <button onClick={onCancel} aria-label="close" className="text-slate-500">✕</button>
        </header>
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-2 py-2">Line</th>
                <th className="px-2 py-2">NPM</th>
                <th className="px-2 py-2">Full name</th>
                <th className="px-2 py-2">Email</th>
                <th className="px-2 py-2">Class</th>
                <th className="px-2 py-2">Track</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((r, idx) => {
                const invalid = Object.keys(r.errors).length > 0;
                return (
                  <tr key={r.line} className={`border-t ${invalid ? 'bg-red-50/60' : ''}`}>
                    <td className="px-2 py-1">{r.line}</td>
                    {(['npm', 'fullName', 'email'] as const).map((f) => (
                      <td key={f} className="px-2 py-1">
                        <input
                          value={String(r.data[f] ?? '')}
                          onChange={(e) => editField(idx, f, e.target.value)}
                          className="w-full min-w-[80px] rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-slate-300 focus:border-blue-400 focus:bg-white focus:outline-none"
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1">{r.data.class_type}</td>
                    <td className="px-2 py-1">{r.data.research_track}</td>
                    <td className="px-2 py-1">
                      {invalid ? (
                        <span className="text-red-600" title={Object.values(r.errors).join('; ')}>
                          ⚠ {Object.values(r.errors)[0]}
                        </span>
                      ) : (
                        <span className="text-emerald-600">✓ valid</span>
                      )}
                      <label className="ml-2 text-slate-500">
                        <input
                          type="checkbox"
                          checked={r.excluded}
                          onChange={(e) => {
                            const rows = [...state.rows];
                            rows[idx] = { ...r, excluded: e.target.checked };
                            onChange({ ...state, rows });
                          }}
                        />{' '}
                        skip
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="flex justify-end gap-2 border-t px-4 py-3">
          <button onClick={onCancel} className="rounded-lg border px-4 py-2">Cancel</button>
          <button onClick={onCommit} className="rounded-lg bg-slate-900 px-4 py-2 text-white">
            Commit {validCount} valid rows
          </button>
        </footer>
      </div>
    </div>
  );
}
