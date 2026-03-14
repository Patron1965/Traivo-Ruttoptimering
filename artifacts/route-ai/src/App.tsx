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
import NotFound from "@/pages/not-found";
import { ChatPanel } from "@/components/chat/ChatPanel";

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
      <Route path="/routes/:id">
        {(params) => <RouteDetail id={params.id} />}
      </Route>
      <Route path="/sustainability" component={Sustainability} />
      <Route path="/history" component={RouteHistory} />
      <Route path="/drivers" component={Drivers} />
      <Route path="/track/:code">
        {(params) => <TrackingPage code={params.code} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRouter />
        </WouterRouter>
        <ChatPanel />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
