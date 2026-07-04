import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from '../lib/api';

// Global session state (rule 10). Wrap the app in <AuthProvider>; consume with
// useAuth(). The sidebar identity block and every role gate read from here.

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'admin' | 'reviewer' | 'editor';
  handle: string;
}

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  canApprove: boolean; // editors edit; admin/reviewer approve + publish
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: SessionUser }>('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ user: SessionUser }>('/api/auth/login', { email, password });
    setUser(r.user);
  };

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
    window.location.assign('/login');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout,
        canApprove: user?.role === 'admin' || user?.role === 'reviewer'
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
