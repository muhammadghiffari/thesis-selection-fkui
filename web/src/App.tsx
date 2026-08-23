import { useEffect, useState } from 'react';

interface Health {
  status: string;
  info?: Record<string, { status: string }>;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Thesis Selection</h1>
      <p className="text-slate-600">FKUI — title selection platform (F1 foundation)</p>
      {error && (
        <p data-testid="health" className="rounded-lg bg-red-100 px-4 py-2 text-red-700">
          API unreachable: {error}
        </p>
      )}
      {health && (
        <p data-testid="health" className="rounded-lg bg-emerald-100 px-4 py-2 text-emerald-700">
          API status: {health.status}
        </p>
      )}
    </main>
  );
}
