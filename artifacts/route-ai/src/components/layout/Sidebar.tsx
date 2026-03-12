import { Link, useLocation } from "wouter";
import { LayoutDashboard, Map as MapIcon, Truck, MapPin, Route as RouteIcon, Command, Cpu, Leaf, Clock, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/map", label: "Live Map", icon: MapIcon },
  { href: "/planner", label: "Route Planner", icon: Cpu },
  { href: "/routes", label: "All Routes", icon: RouteIcon },
  { href: "/vehicles", label: "Fleet", icon: Truck },
  { href: "/drivers", label: "Drivers", icon: Users },
  { href: "/stops", label: "Stops", icon: MapPin },
  { href: "/sustainability", label: "CO₂ Dashboard", icon: Leaf },
  { href: "/history", label: "Route History", icon: Clock },
];

export function Sidebar({ className }: { className?: string }) {
  const [location] = useLocation();

  return (
    <aside className={cn("flex h-full flex-col bg-sidebar border-r border-sidebar-border shadow-2xl shadow-black/50 z-20", className)}>
      <div className="p-6 flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-emerald-500 flex items-center justify-center shadow-lg shadow-primary/20">
          <Command className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-display font-bold text-xl tracking-tight text-sidebar-foreground">Route<span className="text-primary">AI</span></span>
      </div>
      
      <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link 
              key={item.href} 
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group relative",
                isActive 
                  ? "text-sidebar-primary-foreground bg-sidebar-primary/10 shadow-sm" 
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
              )}
            >
              {isActive && (
                <div className="absolute inset-y-0 left-0 w-1 bg-primary rounded-r-full" />
              )}
              <item.icon className={cn("h-5 w-5", isActive ? "text-primary" : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80")} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 mt-auto">
        <div className="p-4 rounded-xl bg-gradient-to-br from-sidebar-accent/50 to-sidebar-accent border border-sidebar-border">
          <p className="text-xs font-medium text-sidebar-foreground">Stockholm Logistics AB</p>
          <p className="text-[10px] text-sidebar-foreground/50 mt-1 truncate">ID: 63e7175d...</p>
        </div>
      </div>
    </aside>
  );
}
