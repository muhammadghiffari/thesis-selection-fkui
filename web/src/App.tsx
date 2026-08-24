import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { RequireAdmin, LogoutButton, LoginPage } from './auth';
import { StudentsPage } from './pages/StudentsPage';
import { PeriodsPage } from './pages/PeriodsPage';
import { ThesesPage } from './pages/ThesesPage';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { LobbyPage, MagicEntryPage } from './pages/StudentPages';
import { RulesPage } from './pages/RulesPage';
import { ReceiptPage, WarRoomPage } from './pages/WarPages';

function Shell() {
  const location = useLocation();
  const tabs = [
    { to: '/students', label: 'Students' },
    { to: '/theses', label: 'Theses' },
    { to: '/periods', label: 'Periods' },
    { to: '/deliveries', label: 'Deliveries' },
  ];
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="sticky top-0 z-10 flex items-center gap-1 border-b bg-white px-4 py-2">
        <span className="mr-2 text-sm font-semibold">FKUI Admin</span>
        {tabs.map((t) => (
          <a
            key={t.to}
            href={`#${t.to}`}
            className={`rounded-lg px-3 py-1.5 text-sm ${location.pathname === t.to ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
          >
            {t.label}
          </a>
        ))}
        <span className="ml-auto"><LogoutButton /></span>
      </nav>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <Routes>
          <Route path="/students" element={<StudentsPage />} />
          <Route path="/theses" element={<ThesesPage />} />
          <Route path="/periods" element={<PeriodsPage />} />
          <Route path="/deliveries" element={<DeliveriesPage />} />
          <Route path="*" element={<Navigate to="/students" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* student-facing (magic session, not admin) */}
        <Route path="/magic/:token" element={<MagicEntryPage />} />
        <Route path="/lobby" element={<LobbyPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/war" element={<WarRoomPage />} />
        <Route path="/receipt" element={<ReceiptPage />} />
        {/* admin shell */}
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAdmin />}>
          <Route path="/*" element={<Shell />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

