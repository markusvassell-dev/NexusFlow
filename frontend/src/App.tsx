import { useAuth } from './context/AuthContext';
import Login from './pages/Login';
import ReviewQueue from './pages/ReviewQueue';
import Settings from './pages/Settings';

// Path-based routing without a router dependency: the Express server returns
// index.html for every non-/api path, and nav links are plain <a href>.
// api.ts already kicks 401s to /login.

const NAV = [
  { path: '/', label: 'Review Queue' },
  { path: '/settings', label: 'Settings' }
];

export default function App() {
  const { user, loading, logout } = useAuth();
  const path = window.location.pathname;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-100 font-mono text-[10px] uppercase tracking-widest text-stone-500">
        restoring session…
      </div>
    );
  }

  if (path === '/login') {
    if (user) {
      window.location.replace('/');
      return null;
    }
    return <Login />;
  }

  if (!user) {
    window.location.replace('/login');
    return null;
  }

  const initials = `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase();

  return (
    <div className="grid min-h-screen grid-cols-[15rem_1fr] bg-stone-100">
      <aside className="flex flex-col border-r border-stone-200 bg-white">
        <div className="flex items-center gap-2.5 border-b border-stone-100 p-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-800 text-sm font-bold text-stone-50">N</div>
          <div>
            <div className="font-bold leading-tight">NexusFlow</div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-stone-500">marketing ops</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((n) => (
            <a
              key={n.path}
              href={n.path}
              className={`block rounded-md px-3 py-2 text-sm ${
                path === n.path ? 'bg-emerald-50 font-semibold text-emerald-900' : 'text-stone-600 hover:bg-stone-50'
              }`}
            >
              {n.label}
            </a>
          ))}
        </nav>

        <div className="border-t border-stone-100 p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-200 text-xs font-semibold text-stone-700">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">
                {user.firstName} {user.lastName}
              </p>
              <p className="font-mono text-[9px] uppercase tracking-widest text-stone-500">{user.role}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="mt-2.5 w-full rounded-md border border-stone-200 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
          >
            Log out
          </button>
        </div>
      </aside>

      <main className="min-w-0">{path.startsWith('/settings') ? <Settings /> : <ReviewQueue />}</main>
    </div>
  );
}
