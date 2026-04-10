import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/i18n";

import Dashboard from "@/pages/Dashboard";
import MapPage from "@/pages/MapPage";
import Vehicles from "@/pages/Vehicles";
import Stops from "@/pages/Stops";
import Planner from "@/pages/Planner";
import Dispatch from "@/pages/Dispatch";
import Routes from "@/pages/Routes";
import CreateRoute from "@/pages/CreateRoute";
import Sustainability from "@/pages/Sustainability";
import RouteHistory from "@/pages/RouteHistory";
import Drivers from "@/pages/Drivers";
import RouteDetail from "@/pages/RouteDetail";
import TrackingPage from "@/pages/TrackingPage";
import DriverView from "@/pages/DriverView";
import DriverPerformance from "@/pages/DriverPerformance";
import Analytics from "@/pages/Analytics";
import RouteComparison from "@/pages/RouteComparison";
import Webhooks from "@/pages/Webhooks";
import ShopifyIntegration from "@/pages/ShopifyIntegration";
import Import from "@/pages/Import";
import Billing from "@/pages/Billing";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/not-found";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/context/ThemeContext";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5,
    }
  }
});

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/map" component={MapPage} />
      <Route path="/vehicles" component={Vehicles} />
      <Route path="/stops" component={Stops} />
      <Route path="/planner" component={Planner} />
      <Route path="/dispatch" component={Dispatch} />
      <Route path="/routes" component={Routes} />
      <Route path="/routes/create" component={CreateRoute} />
      <Route path="/routes/:id/compare">
        {(params) => <RouteComparison id={params.id} />}
      </Route>
      <Route path="/routes/:id">
        {(params) => <RouteDetail id={params.id} />}
      </Route>
      <Route path="/sustainability" component={Sustainability} />
      <Route path="/history" component={RouteHistory} />
      <Route path="/drivers" component={Drivers} />
      <Route path="/drivers/:id">
        {(params) => <DriverPerformance id={params.id} />}
      </Route>
      <Route path="/analytics" component={Analytics} />
      <Route path="/webhooks" component={Webhooks} />
      <Route path="/shopify" component={ShopifyIntegration} />
      <Route path="/import" component={Import} />
      <Route path="/billing" component={Billing} />
      <Route path="/settings" component={Settings} />
      <Route path="/driver-view" component={DriverView} />
      <Route path="/track/:code">
        {(params) => <TrackingPage code={params.code} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function RealtimeSyncProvider({ children }: { children: React.ReactNode }) {
  useRealtimeSync();
  return <>{children}</>;
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <RealtimeSyncProvider>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <AppRouter />
              </WouterRouter>
              <ChatPanel />
              <CommandPalette />
              <Toaster />
            </TooltipProvider>
          </RealtimeSyncProvider>
        </QueryClientProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
