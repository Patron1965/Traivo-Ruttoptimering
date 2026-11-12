import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { initWsClient, resetWsClient } from "./ws-client";
import { clearLocalWorkspace } from "./workspace-context";
import { readSession } from "./session-request";

export type UserRole = "admin" | "dispatcher" | "driver" | "viewer";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isPlatformAdmin?: boolean;
  platformPasswordOnlyTestMode?: boolean;
  organizationId: string;
  homeOrganizationId?: string;
  workspace?: { organizationId: string; organizationName: string; expiresAt: string };
  driverProfileId: string | null;
}

export interface SessionMeta {
  idleTimeoutMin: number;
  absoluteTimeoutHours: number;
  absoluteExpiresAt: string;
}

interface AuthContextType {
  user: AuthUser | null;
  session: SessionMeta | null;
  isLoading: boolean;
  sessionError: string | null;
  isLoggingOut: boolean;
  logoutError: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  finishMfa: (user: AuthUser, session: SessionMeta) => void;
  logout: () => Promise<boolean>;
  refreshSession: () => Promise<boolean>;
  hasRole: (...roles: UserRole[]) => boolean;
  isAdmin: boolean;
  isDispatcher: boolean;
  isDriver: boolean;
  isViewer: boolean;
}

function apiUrl(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/api${path}`;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  isLoading: true,
  sessionError: null,
  isLoggingOut: false,
  logoutError: null,
  login: async () => false,
  finishMfa: () => {},
  logout: async () => false,
  refreshSession: async () => false,
  hasRole: () => false,
  isAdmin: false,
  isDispatcher: false,
  isDriver: false,
  isViewer: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const logoutInFlight = useRef(false);

  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      const data = await readSession<{ user: AuthUser; session?: SessionMeta }>(apiUrl("/auth/me"));
      setSessionError(null);
      if (!data) {
        resetWsClient();
        setUser(null);
        setSession(null);
        return false;
      }
      initWsClient(data.user.organizationId);
      setUser(data.user);
      setSession(data.session ?? null);
      return true;
    } catch {
      setSessionError("Det går inte att kontrollera inloggningen just nu. Servern svarar inte eller är tillfälligt otillgänglig. Försök igen om en stund.");
      resetWsClient();
      setUser(null);
      setSession(null);
      return false;
    }
  }, []);

  useEffect(() => {
    (async () => {
      await refreshSession();
      setIsLoading(false);
    })();
  }, [refreshSession]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(apiUrl("/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Inloggningen misslyckades" }));
      const error = new Error(body.error || "Inloggningen misslyckades");
      Object.assign(error, { status: res.status, data: body });
      throw error;
    }
    const data = await res.json();
    if (data.mfaRequired) return true;
    initWsClient(data.user.organizationId);
    setUser(data.user);
    setSession(data.session ?? null);
    return false;
  }, []);

  const finishMfa = useCallback((authenticated: AuthUser, meta: SessionMeta) => {
    initWsClient(authenticated.organizationId);
    setUser(authenticated);
    setSession(meta);
  }, []);

  const logout = useCallback(async (): Promise<boolean> => {
    if (logoutInFlight.current) return false;
    logoutInFlight.current = true;
    setLogoutError(null);
    setIsLoggingOut(true);
    try {
      const res = await fetch(apiUrl("/auth/logout"), { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Logout request failed");
      clearLocalWorkspace();
      resetWsClient();
      setUser(null);
      setSession(null);
      if (user?.isPlatformAdmin) {
        const base = import.meta.env.BASE_URL.replace(/\/$/, "");
        window.location.assign(`${base}/platform/login`);
      }
      return true;
    } catch {
      setLogoutError("Utloggningen misslyckades. Kontrollera anslutningen och försök igen.");
      return false;
    } finally {
      logoutInFlight.current = false;
      setIsLoggingOut(false);
    }
  }, [user?.isPlatformAdmin]);

  const hasRole = (...roles: UserRole[]) => {
    if (!user) return false;
    if (user.role === "admin") return true;
    return roles.includes(user.role);
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      isLoading,
      sessionError,
      isLoggingOut,
      logoutError,
      login,
      finishMfa,
      logout,
      refreshSession,
      hasRole,
      isAdmin: user?.role === "admin",
      isDispatcher: user?.role === "dispatcher",
      isDriver: user?.role === "driver",
      isViewer: user?.role === "viewer",
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
