import { FormEvent, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../lib/api';

// /login — email + password against /api/auth/login. On success the session
// cookie is set and the router sends the user to the runs overview.

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Invalid email or password.' : 'Sign-in failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-stone-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-emerald-800 text-stone-50 flex items-center justify-center font-bold">N</div>
          <div>
            <div className="font-bold text-lg leading-tight">NexusFlow</div>
            <div className="text-[10px] uppercase tracking-widest text-stone-500 font-mono">marketing ops · team sign-in</div>
          </div>
        </div>

        <form onSubmit={submit} className="mt-5 bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
          <label className="block text-[10px] uppercase tracking-widest text-stone-500 font-mono">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@aegisadvisory.co.uk"
            className="mt-1 w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm outline-none focus:border-emerald-700"
          />
          <label className="mt-4 block text-[10px] uppercase tracking-widest text-stone-500 font-mono">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="mt-1 w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm outline-none focus:border-emerald-700"
          />
          {error && <p className="mt-3 text-xs text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-lg bg-emerald-800 py-2.5 text-sm font-semibold text-white hover:bg-emerald-900 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
