import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type UserRole = "admin" | "dispatcher" | "driver";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  organizationId: string;
  driverProfileId: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  setUser: (user: AuthUser | null) => void;
  hasRole: (...roles: UserRole[]) => boolean;
  isAdmin: boolean;
  isDispatcher: boolean;
  isDriver: boolean;
}

const DEFAULT_USERS: AuthUser[] = [
  { id: "a1000000-0000-0000-0000-000000000001", name: "Admin User", email: "admin@stockholm-logistics.se", role: "admin", organizationId: "63e7175d-af1d-4dc3-be62-842a8b3dc9f8", driverProfileId: null },
  { id: "a1000000-0000-0000-0000-000000000002", name: "Dispatch User", email: "dispatch@stockholm-logistics.se", role: "dispatcher", organizationId: "63e7175d-af1d-4dc3-be62-842a8b3dc9f8", driverProfileId: null },
  { id: "a1000000-0000-0000-0000-000000000003", name: "Tomas Björnberg", email: "tomas@stockholm-logistics.se", role: "driver", organizationId: "63e7175d-af1d-4dc3-be62-842a8b3dc9f8", driverProfileId: null },
];

const AuthContext = createContext<AuthContextType>({
  user: null,
  setUser: () => {},
  hasRole: () => true,
  isAdmin: false,
  isDispatcher: false,
  isDriver: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const saved = localStorage.getItem("routeai_user");
    if (saved) {
      try { return JSON.parse(saved); } catch { return DEFAULT_USERS[0]; }
    }
    return DEFAULT_USERS[0];
  });

  useEffect(() => {
    if (user) {
      localStorage.setItem("routeai_user", JSON.stringify(user));
    } else {
      localStorage.removeItem("routeai_user");
    }
  }, [user]);

  const hasRole = (...roles: UserRole[]) => {
    if (!user) return false;
    if (user.role === "admin") return true;
    return roles.includes(user.role);
  };

  return (
    <AuthContext.Provider value={{
      user,
      setUser,
      hasRole,
      isAdmin: user?.role === "admin",
      isDispatcher: user?.role === "dispatcher",
      isDriver: user?.role === "driver",
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export { DEFAULT_USERS };
