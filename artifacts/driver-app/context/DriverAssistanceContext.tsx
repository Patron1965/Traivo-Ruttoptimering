import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import {
  setDriverAssistanceContext as setApiDriverAssistanceContext,
  type Driver,
} from "@/lib/api";
import { removeCachedData } from "@/lib/offline-queue";

export type AssistanceSelection = { driver: Driver; routeId: string; routeName: string };

interface DriverAssistanceState {
  selection: AssistanceSelection | null;
  assistedDriver: Driver | null;
  isAssisting: boolean;
  selectAssistance: (selection: AssistanceSelection) => void;
  clearAssistance: () => void;
}

const DriverAssistanceContext = createContext<DriverAssistanceState | null>(null);

const SCOPED_QUERY_KEYS = [
  "routes",
  "stops",
  "route-incidents",
  "route-execution",
  "driver-stats",
  "driver-prefs",
] as const;

/**
 * This context never changes AuthContext's user.  It scopes only route-driver
 * actions and clears all scoped react-query data whenever selection changes.
 */
export function DriverAssistanceProvider({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<AssistanceSelection | null>(null);
  const isAssisting = Boolean(isAdmin && selection);

  useEffect(() => {
    const context = isAdmin && selection
      ? { driverId: selection.driver.id, routeId: selection.routeId }
      : null;
    setApiDriverAssistanceContext(context);
    return () => setApiDriverAssistanceContext(null);
  }, [isAdmin, selection?.driver.id, selection?.routeId]);

  useEffect(() => {
    if (!isAdmin && selection) setSelection(null);
  }, [isAdmin, selection]);

  const value = useMemo<DriverAssistanceState>(() => ({
    selection: isAssisting ? selection : null,
    assistedDriver: isAssisting ? selection!.driver : null,
    isAssisting,
    selectAssistance: (next) => {
      // Removal prevents an in-flight cached projection being rendered after a
      // driver/route switch. Offline actions are never enabled for admins.
      SCOPED_QUERY_KEYS.forEach((queryKey) => queryClient.removeQueries({ queryKey: [queryKey] }));
      void removeCachedData(["routes_", "stops_"]);
      setApiDriverAssistanceContext({ driverId: next.driver.id, routeId: next.routeId });
      setSelection(next);
    },
    clearAssistance: () => {
      SCOPED_QUERY_KEYS.forEach((queryKey) => queryClient.removeQueries({ queryKey: [queryKey] }));
      void removeCachedData(["routes_", "stops_"]);
      setApiDriverAssistanceContext(null);
      setSelection(null);
    },
  }), [isAssisting, queryClient, selection]);

  return <DriverAssistanceContext.Provider value={value}>{children}</DriverAssistanceContext.Provider>;
}

export function useDriverAssistance() {
  const value = useContext(DriverAssistanceContext);
  if (!value) throw new Error("DriverAssistanceProvider is missing");
  return value;
}