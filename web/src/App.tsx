import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { onBanner, connectRealtime } from './lib/realtime';
import { RequireAdmin, RequireRole, LogoutButton, LoginPage } from './auth';
import { StudentsPage } from './pages/StudentsPage';
import { PeriodsPage } from './pages/PeriodsPage';
import { ThesesPage } from './pages/ThesesPage';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { LobbyPage, MagicEntryPage } from './pages/StudentPages';
import { RulesPage } from './pages/RulesPage';
import { ReceiptPage, WarRoomPage } from './pages/WarPages';
import { MySwapsPage, SwapReviewPage } from './pages/SwapPages';
import { LecturerDashboardPage } from './pages/LecturerPages';
import { AdminMonitorPage, AuditViewerPage, IntegrityQueuePage } from './pages/SupervisorPages';

function BannerToast() {
  const [banner, setBanner] = useState<{ message: string; at: string } | null>(null);
  useEffect(() => {
    connectRealtime();
    return onBanner(setBanner);
  }, []);
  if (!banner) return null;
  return (
    <div role="alert" className="fixed inset-x-3 top-14 z-50 mx-auto max-w-md rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg sm:left-1/2 sm:right-auto sm:-translate-x-1/2">
      {banner.message}
      <button className="ml-3 underline" onClick={() => setBanner(null)}>dismiss</button>
    </div>
  );
}

function ShellLecturer() {
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="sticky top-0 z-10 flex items-center gap-1 border-b bg-white px-4 py-2">
        <span className="mr-2 text-sm font-semibold">FKUI Supervisor</span>
        <Link to="/lecturer" className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white">Dashboard</Link>
        <span className="ml-auto"><LogoutButton /></span>
      </nav>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <Routes>
          <Route path="/lecturer" element={<LecturerDashboardPage />} />
          <Route path="*" element={<Navigate to="/lecturer" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Shell() {
  const location = useLocation();
  const tabs = [
    { to: '/students', label: 'Students' },
    { to: '/theses', label: 'Theses' },
    { to: '/periods', label: 'Periods' },
    { to: '/deliveries', label: 'Deliveries' },
    { to: '/swaps-review', label: 'Swap review' },
    { to: '/monitor', label: 'Monitor' },
    { to: '/integrity', label: 'Integrity' },
    { to: '/audit', label: 'Audit log' },
  ];
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="sticky top-0 z-10 flex items-center gap-1 border-b bg-white px-4 py-2">
        <span className="mr-2 text-sm font-semibold">FKUI Admin</span>
        {tabs.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className={`rounded-lg px-3 py-1.5 text-sm ${location.pathname === t.to ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
          >
            {t.label}
          </Link>
        ))}
        <span className="ml-auto"><LogoutButton /></span>
      </nav>
      <BannerToast />
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <Routes>
          <Route path="/students" element={<StudentsPage />} />
          <Route path="/theses" element={<ThesesPage />} />
          <Route path="/periods" element={<PeriodsPage />} />
          <Route path="/deliveries" element={<DeliveriesPage />} />
          <Route path="/swaps-review" element={<SwapReviewPage />} />
          <Route path="/monitor" element={<AdminMonitorPage />} />
          <Route path="/integrity" element={<IntegrityQueuePage scope="admin" />} />
          <Route path="/audit" element={<AuditViewerPage />} />
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
        <Route path="/my-swaps" element={<MySwapsPage />} />
        {/* lecturer area (server-scoped endpoints) */}
        <Route element={RequireRole(['lecturer', 'admin'])()}>
          <Route path="/lecturer" element={<ShellLecturer />} />
        </Route>
        {/* admin shell */}
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAdmin />}>
          <Route path="/*" element={<Shell />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

