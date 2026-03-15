import React, { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, type Driver } from "@/lib/api";

interface AuthState {
  driver: Driver | null;
  isLoading: boolean;
  drivers: Driver[];
  selectDriver: (driver: Driver) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = "routeai_driver_id";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [driver, setDriver] = useState<Driver | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadDrivers();
  }, []);

  async function loadDrivers() {
    try {
      const allDrivers = await api.getDrivers();
      setDrivers(allDrivers);

      const savedId = await AsyncStorage.getItem(STORAGE_KEY);
      if (savedId) {
        const found = allDrivers.find((d) => d.id === savedId);
        if (found) setDriver(found);
      }
    } catch (err) {
      console.error("Failed to load drivers:", err);
    } finally {
      setIsLoading(false);
    }
  }

  async function selectDriver(d: Driver) {
    setDriver(d);
    await AsyncStorage.setItem(STORAGE_KEY, d.id);
  }

  async function logout() {
    setDriver(null);
    await AsyncStorage.removeItem(STORAGE_KEY);
  }

  return (
    <AuthContext.Provider value={{ driver, isLoading, drivers, selectDriver, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
