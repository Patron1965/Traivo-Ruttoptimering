import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { useEffect, useState } from "react";
import { leaveWorkspace, workspaceFailed, workspaceToken } from "@/lib/workspace-context";
import { resetWsClient } from "@/lib/ws-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/i18n";

import MapPage from "@/pages/MapPage";
import Vehicles from "@/pages/Vehicles";
import Drivers from "@/pages/Drivers";
import Stops from "@/pages/Stops";
import Planner from "@/pages/Planner";
import Dispatch from "@/pages/Dispatch";
import Dashboard from "@/pages/Dashboard";
import Routes from "@/pages/Routes";
import CreateRoute from "@/pages/CreateRoute";
import Import, { ImportEntry } from "@/pages/Import";
import Sustainability from "@/pages/Sustainability";
import RouteDetail from "@/pages/RouteDetail";
import Customers from "@/pages/Customers";
import TrackingPage from "@/pages/TrackingPage";
import DriverView from "@/pages/DriverView";
import DriverPerformance from "@/pages/DriverPerformance";
import Analytics from "@/pages/Analytics";
import Operations from "@/pages/Operations";
import RouteComparison from "@/pages/RouteComparison";
import Webhooks from "@/pages/Webhooks";
import ShopifyIntegration from "@/pages/ShopifyIntegration";
import Billing from "@/pages/Billing";
import Settings from "@/pages/Settings";
import AppUsers from "@/pages/Users";
import UserGroups from "@/pages/UserGroups";
import Reports from "@/pages/Reports";
import Documents from "@/pages/Documents";
import SecurityLogs from "@/pages/SecurityLogs";
import MapPopout from "@/pages/MapPopout";
import GanttPopout from "@/pages/GanttPopout";
import NotFound from "@/pages/not-found";
import PlatformAdmin from "@/pages/PlatformAdmin";
import Districts from "@/pages/Districts";
import AiSupport from "@/pages/AiSupport";
import CustomerPortalAdmin from "@/pages/CustomerPortalAdmin";
import PortalApp, { isPortalPath } from "@/pages/portal/PortalApp";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { ThemeProvider } from "@/context/ThemeContext";
import { BrandingProvider } from "@/context/BrandingContext";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import Login from "@/pages/Login";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import { IdleWarning } from "@/components/IdleWarning";
import { Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import { useMemo } from "react";

function ScopedQueryProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const queryClient = useMemo(() => new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5,
    }
  }
  }), [user?.id, user?.organizationId]);
  useEffect(() => () => { queryClient.clear(); }, [queryClient]);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Admin/dispatcher use the unified traffic workspace; drivers/viewers keep the restricted map. */
function MapEntry() {
  const { user } = useAuth();
  if (user?.role === "admin" || user?.role === "dispatcher") {
    return <Redirect to="/dispatch?view=traffic&mode=live&layout=map" />;
  }
  return <MapPage />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/routes" />
      </Route>
      <Route path="/map" component={MapEntry} />
      <Route path="/overview" component={Dashboard} />
      <Route path="/vehicles" component={Vehicles} />
      <Route path="/orders" component={Stops} />
      <Route path="/stops">
        <Redirect to="/orders" />
      </Route>
      <Route path="/planner" component={Planner} />
      <Route path="/dispatch" component={Dispatch} />
      <Route path="/routes" component={Routes} />
      <Route path="/routes/create" component={CreateRoute} />
      <Route path="/customers" component={Customers} />
      <Route path="/routes/drafts/:id">
        {(params) => <Import draftId={params.id} />}
      </Route>
      <Route path="/routes/:id/compare">
        {(params) => <RouteComparison id={params.id} />}
      </Route>
      <Route path="/routes/:id">
        {(params) => <RouteDetail id={params.id} />}
      </Route>
      <Route path="/sustainability" component={Sustainability} />
      <Route path="/history">
        <Redirect to="/routes" />
      </Route>
      <Route path="/drivers" component={Drivers} />
      <Route path="/drivers/:id">
        {(params) => <DriverPerformance id={params.id} />}
      </Route>
      <Route path="/districts">{() => <Districts />}</Route>
      <Route path="/districts/:planId">
        {(params) => <Districts planId={params.planId} />}
      </Route>
      <Route path="/analytics" component={Analytics} />
      <Route path="/operations" component={Operations} />
      <Route path="/webhooks" component={Webhooks} />
      <Route path="/shopify" component={ShopifyIntegration} />
      <Route path="/import">
        <ImportEntry />
      </Route>
      <Route path="/platform" component={PlatformAdmin} />
      <Route path="/platform/login" component={Login} />
      <Route path="/billing" component={Billing} />
      <Route path="/settings" component={Settings} />
      <Route path="/ai-support" component={AiSupport} />
      <Route path="/users" component={AppUsers} />
      <Route path="/user-groups" component={UserGroups} />
      <Route path="/reports" component={Reports} />
      <Route path="/documents" component={Documents} />
      <Route path="/orders-pickup-delivery">
        <Redirect to="/orders?orderType=pickup_delivery" />
      </Route>
      <Route path="/customer-portal" component={CustomerPortalAdmin} />
      <Route path="/security-logs" component={SecurityLogs} />
      <Route path="/driver-view" component={DriverView} />
      <Route path="/map-popout" component={MapPopout} />
      <Route path="/gantt-popout" component={GanttPopout} />
      <Route path="/track/:code">
        {(params) => <TrackingPage code={params.code} />}
      </Route>
      <Route path="/login" component={Login} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route component={NotFound} />
    </Switch>
  );
}

function RealtimeSyncProvider({ children }: { children: React.ReactNode }) {
  useRealtimeSync();
  return <>{children}</>;
}

function AuthGate() {
  const { user, isLoading, sessionError, isLoggingOut, logoutError, logout } = useAuth();
  const [location] = useLocation();
  const [workspaceInvalid, setWorkspaceInvalid] = useState(workspaceFailed);
  const [workspaceError, setWorkspaceError] = useState("");
  useEffect(() => {
    const invalid = () => { resetWsClient(); setWorkspaceInvalid(true); };
    window.addEventListener("traivo-workspace-invalid", invalid);
    return () => window.removeEventListener("traivo-workspace-invalid", invalid);
  }, []);
  useEffect(() => {
    if (!user?.workspace) return;
    const timer = window.setTimeout(() => { resetWsClient(); setWorkspaceInvalid(true); },
      Math.max(0, Date.parse(user.workspace.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [user?.workspace?.expiresAt]);
  const exitWorkspace = () => void leaveWorkspace().catch(error => setWorkspaceError(error.message));

  if (workspaceInvalid || (workspaceToken && !isLoading && !user && !sessionError)) {
    return <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Företagsåtkomsten har upphört</h1>
      <p>Inga ändringar skickas automatiskt igen. Välj företag på nytt i Superuser.</p>
      <button className="rounded bg-primary p-3 text-primary-foreground" onClick={exitWorkspace}>Tillbaka till Superuser</button>
      {workspaceError && <p role="alert">{workspaceError}</p>}
    </div>;
  }

  if (isLoggingOut || logoutError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-6 text-center" role="status" aria-live="polite">
        {isLoggingOut ? (
          <><Loader2 className="h-6 w-6 animate-spin" /><p>Loggar ut…</p></>
        ) : (
          <><p role="alert">{logoutError}</p><button type="button" className="rounded bg-primary px-4 py-2 text-primary-foreground" onClick={() => void logout()}>Försök igen</button></>
        )}
      </div>
    );
  }

  const isPublic =
    location.startsWith("/track/") ||
    location === "/login" ||
    location === "/platform/login" ||
    location === "/forgot-password" ||
    location === "/reset-password";

  if (isPublic) {
    return <AppRouter />;
  }

  if (!isLoading && !user && sessionError) {
    return <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Servern är tillfälligt otillgänglig</h1>
      <p role="alert" className="max-w-lg text-center">{sessionError}</p>
      <button className="rounded bg-primary p-3 text-primary-foreground" onClick={() => window.location.reload()}>
        Försök igen
      </button>
    </div>;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }
  if (user.isPlatformAdmin && !user.workspace && location !== "/platform") return <Redirect to="/platform" />;

  // Provider administration does not mount customer branding, chat or
  // workspace navigation. API authorization remains the actual boundary.
  if (location === "/platform") return <AppRouter />;

  return (
    <>
    {user.workspace && <div role="status" className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-950 border-b border-amber-300">
      <span><strong>Superuser · {user.workspace.organizationName}</strong> — operativ företagsåtkomst</span>
      <button className="font-semibold underline" onClick={exitWorkspace}>Tillbaka till Superuser / Byt företag</button>
      {workspaceError && <span role="alert">{workspaceError}</span>}
    </div>}
    <BrandingProvider>
      <ChatPanel>
      <AppRouter />
      <CommandPalette />
      <IdleWarning />
      </ChatPanel>
    </BrandingProvider>
    </>
  );
}

function App() {
  // Customer portal: standalone, before staff auth/providers, own query cache.
  if (isPortalPath(window.location.pathname)) return <PortalApp />;
  return (
    <ThemeProvider>
      <AuthProvider>
        <ScopedQueryProvider>
            <RealtimeSyncProvider>
              <TooltipProvider>
                <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                  <AuthGate />
                </WouterRouter>
                <Toaster />
              </TooltipProvider>
            </RealtimeSyncProvider>
        </ScopedQueryProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
