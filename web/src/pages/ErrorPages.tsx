import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Clean fallback for every HTTP error the API can return (OWASP A05/A09). */
export function ErrorShell({
  code,
  title,
  message,
  home = '/',
}: {
  code: string;
  title: string;
  message: string;
  home?: string;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-6xl font-bold tracking-tight text-slate-300">{code}</p>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-slate-600">{message}</p>
      <div className="mt-2 flex gap-2">
        <Link to={home} className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">
          Back home
        </Link>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg border px-4 py-2 text-sm hover:bg-slate-100"
        >
          Retry
        </button>
      </div>
      <p className="text-xs text-slate-400">If this keeps happening, contact the admin with your request ID from the URL bar.</p>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <ErrorShell
      code="404"
      title="Page not found"
      message="The page you asked for does not exist or was moved."
    />
  );
}

export function ForbiddenPage() {
  return (
    <ErrorShell
      code="403"
      title="Access forbidden"
      message="Your account does not have permission to view this page. The server checks permissions again — the UI link simply does not exist for your role."
    />
  );
}

export function UnauthorizedPage() {
  return (
    <ErrorShell
      code="401"
      title="Sign in required"
      message="Your session expired or you are not signed in. Please sign in again."
      home="/login"
    />
  );
}

export function RateLimitedPage() {
  return (
    <ErrorShell
      code="429"
      title="Too many requests"
      message="You are going too fast. Wait a moment and try again."
    />
  );
}

export function ServerErrorPage() {
  return (
    <ErrorShell
      code="500"
      title="Something went wrong"
      message="Our team has been notified. Please retry in a minute."
    />
  );
}

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  hasError: boolean;
}

/** Catches render-time crashes and shows a clean fallback (no white screen). */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('UI error boundary caught:', error);
  }

  render(): ReactNode {
    if (this.state.hasError) return <ServerErrorPage />;
    return this.props.children;
  }
}
