import { Link } from 'react-router-dom';

const RULES: Array<{ title: string; points: string[] }> = [
  {
    title: 'Access',
    points: [
      'Your personal link arrives by email 7 days before selection opens. It works on the FIRST device that opens it — nowhere else.',
      'Opening the link starts a short claim window. Complete the step on the same device.',
      'Lost access? Contact the committee — an admin can issue a fresh link (old ones stop working).',
    ],
  },
  {
    title: 'The war (title selection)',
    points: [
      'At opens_at the full catalog appears simultaneously for everyone.',
      'Tap a card to lock it instantly — first tap to reach the server wins. No confirmation modal during the war.',
      'You must end up with EXACTLY 3 titles, ordered by priority 1–2–3.',
      'Locked cards expire after 30 seconds if you walk away.',
      'After your third claim you get a 15-second undo window.',
    ],
  },
  {
    title: 'Fairness & integrity',
    points: [
      'Winner is decided purely by which request reaches the server first — client clocks are irrelevant.',
      'Titles are hidden until the opening moment. Anyone claiming to know them early is guessing or cheating.',
      'Anomalies (shared devices, impossible speeds) are flagged for human review — never auto-punished.',
    ],
  },
  {
    title: 'Auto-war (optional)',
    points: [
      'Opt-in only, requires explicit pre-confirmation in the lobby.',
      'At the opening second the system locks the best-matching available title for you — but ONLY if this tab is open and visible.',
      'Background tabs are skipped on purpose. If you prefer manual control, do not arm it.',
    ],
  },
  {
    title: 'If something goes wrong',
    points: [
      'Lost duel? The system instantly suggests the closest matching free title based on your saved interests.',
      'Need a different title later? Swap requests go to your lecturer with a written reason.',
      'Help chat lives inside the app during the war window.',
    ],
  },
];

export function RulesPage() {
  return (
    <main className="mx-auto max-w-lg flex-col gap-6 p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold">Selection Rules Guide</h1>
      {RULES.map((section) => (
        <section key={section.title} className="mb-5 rounded-2xl border bg-white p-4 shadow-sm">
          <h2 className="mb-2 font-medium">{section.title}</h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
            {section.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </section>
      ))}
      <p className="pb-8 text-center text-xs text-slate-400">
        Times are shown in WIB but decided by the server clock.
        <br />
        <Link to="/lobby" className="underline">Back to lobby</Link>
      </p>
    </main>
  );
}
