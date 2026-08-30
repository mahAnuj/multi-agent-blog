import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { createApiUrl } from '@/lib/config';
import {
  getAdminToken,
  setAdminToken,
  clearAdminToken,
  authHeaders,
} from '@/lib/admin-token';

interface AdminContextType {
  isAdmin: boolean;
  /** Resolves true when the server accepted the password. */
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  isCheckingSession: boolean;
}

const AdminContext = createContext<AdminContextType | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  // A token in storage proves nothing on its own - ask the server whether it
  // is still valid. Sessions die on server restart, so this matters.
  useEffect(() => {
    let cancelled = false;

    async function validate() {
      if (!getAdminToken()) {
        if (!cancelled) setIsCheckingSession(false);
        return;
      }
      try {
        const res = await fetch(createApiUrl('/api/admin/session'), {
          headers: authHeaders(),
          credentials: 'include',
        });
        if (!cancelled) setIsAdmin(res.ok);
        if (!res.ok) clearAdminToken();
      } catch {
        if (!cancelled) setIsAdmin(false);
      } finally {
        if (!cancelled) setIsCheckingSession(false);
      }
    }

    validate();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (password: string): Promise<boolean> => {
    try {
      const res = await fetch(createApiUrl('/api/admin/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      });
      if (!res.ok) return false;

      const { token } = await res.json();
      if (!token) return false;

      setAdminToken(token);
      setIsAdmin(true);
      return true;
    } catch {
      return false;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await fetch(createApiUrl('/api/admin/logout'), {
        method: 'POST',
        headers: authHeaders(),
        credentials: 'include',
      });
    } catch {
      /* revoke best-effort; the local token goes either way */
    }
    clearAdminToken();
    setIsAdmin(false);
  };

  return (
    <AdminContext.Provider value={{ isAdmin, login, logout, isCheckingSession }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error('useAdmin must be used within AdminProvider');
  }
  return context;
}
