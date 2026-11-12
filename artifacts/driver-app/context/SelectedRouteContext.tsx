import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { useDriverAssistance } from "@/context/DriverAssistanceContext";
import { api, isAuthError, type Route } from "@/lib/api";
import { getCachedData, setCachedData } from "@/lib/offline-queue";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { eligibleRoutes, resolveSelectedRoute } from "@/lib/route-selection";

interface SelectedRouteState {
  routeScopeKey: string | null;
  activeRoutes: Route[];
  activeRoute: Route | null;
  setSelectedRouteId: (id: string) => void;
  routesLoading: boolean;
  routesError: Error | null;
  refetchRoutes: () => Promise<unknown>;
}

const SelectedRouteContext = createContext<SelectedRouteState | null>(null);

export function SelectedRouteProvider({ children }: { children: ReactNode }) {
  const { user, driver, isAdmin } = useAuth();
  const { selection, assistedDriver, isAssisting } = useDriverAssistance();
  const effectiveDriver = isAssisting ? assistedDriver : driver;
  const scope = user && (isAdmin && !isAssisting || effectiveDriver)
    ? JSON.stringify([
      user.organizationId,
      user.id,
      isAssisting ? "assistance" : isAdmin ? "admin-overview" : "driver",
      effectiveDriver?.id,
      effectiveDriver?.vehicleId,
      selection?.routeId,
    ])
    : null;
  // A different account/assignment gets a fresh selection, before children render.
  return <ScopedSelection key={scope ?? "signed-out"} scope={scope}>{children}</ScopedSelection>;
}

function ScopedSelection({ scope, children }: { scope: string | null; children: ReactNode }) {
  const { user, driver, isAdmin } = useAuth();
  const { selection, assistedDriver, isAssisting } = useDriverAssistance();
  const effectiveDriver = isAssisting ? assistedDriver : driver;
  const { isOnline } = useNetworkStatus();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["routes", scope],
    queryFn: async () => {
      if (isAssisting) {
        const routes = await api.getRoutes(effectiveDriver!.id);
        return routes.filter((route) => route.id === selection?.routeId && route.handoffDriverId === effectiveDriver!.id);
      }
      // The tenant-wide overview requires no personal driver assignment.
      // Keep it online-only; it must not reuse a driver's offline route cache.
      if (isAdmin) return api.getRoutes();
      try {
        const routes = await api.getRoutes(effectiveDriver!.id);
        await setCachedData(`routes_${scope}`, routes);
        return routes;
      } catch (error) {
        if (!isOnline && !isAuthError(error)) {
          const cached = await getCachedData<Route[]>(`routes_${scope}`);
          if (cached) return cached;
        }
        throw error;
      }
    },
    enabled: !!scope,
    networkMode: "always",
    refetchInterval: isOnline ? 15000 : false,
  });
  const activeRoutes = useMemo(() => eligibleRoutes(query.data ?? [], scope && user ? {
    organizationId: user.organizationId, driverId: effectiveDriver?.id, isAdmin: isAdmin && !isAssisting,
  } : null), [scope, query.data, user?.organizationId, effectiveDriver?.id, isAdmin, isAssisting]);
  const activeRoute = resolveSelectedRoute(activeRoutes, selectedId);
  useEffect(() => {
    // Commit the fallback so a removed assignment cannot silently reselect itself.
    setSelectedId(activeRoute?.id ?? null);
  }, [activeRoute?.id]);
  return (
    <SelectedRouteContext.Provider value={{
      activeRoutes, activeRoute, routeScopeKey: scope,
      setSelectedRouteId: (id) => {
        if (activeRoutes.some((route) => route.id === id)) setSelectedId(id);
      },
      routesLoading: query.isLoading,
      routesError: query.error,
      refetchRoutes: query.refetch,
    }}>
      {children}
    </SelectedRouteContext.Provider>
  );
}

export function useSelectedRoute() {
  const value = useContext(SelectedRouteContext);
  if (!value) throw new Error("SelectedRouteProvider is missing");
  return value;
}