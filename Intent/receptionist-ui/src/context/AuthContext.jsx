import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

// Hardcoded receptionist accounts (replace with real backend auth later)
const RECEPTIONIST_ACCOUNTS = [
  { username: 'reception1', password: 'clinic2026', name: 'Alice Johnson',   role: 'Senior Receptionist' },
  { username: 'reception2', password: 'clinic2026', name: 'Ben Nguyen',      role: 'Receptionist' },
  { username: 'admin',      password: 'admin2026',  name: 'Admin User',      role: 'Admin' },
];

const SESSION_KEY = 'au_receptionist_session';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      try { setUser(JSON.parse(stored)); } catch {}
    }
    setLoading(false);
  }, []);

  const login = (username, password) => {
    const account = RECEPTIONIST_ACCOUNTS.find(
      (a) => a.username === username && a.password === password
    );
    if (!account) return { success: false, error: 'Invalid username or password' };
    const session = { username: account.username, name: account.name, role: account.role };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    setUser(session);
    return { success: true };
  };

  const logout = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
