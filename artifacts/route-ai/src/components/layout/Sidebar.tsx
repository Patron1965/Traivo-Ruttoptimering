import { Link, useLocation } from "wouter";
import { LayoutDashboard, Map as MapIcon, Truck, MapPin, Route as RouteIcon, Command, Cpu, Leaf, Clock, Users, PlusCircle, CalendarClock, Shield, ChevronDown, Smartphone, BarChart3, Sun, Moon, Webhook } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useAuth, DEFAULT_USERS, type UserRole } from "@/lib/auth-context";
import { useTheme } from "@/context/ThemeContext";
import { useState } from "react";

type NavItem = {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  roles?: UserRole[];
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", labelKey: "sidebar.dashboard", icon: LayoutDashboard },
  { href: "/map", labelKey: "sidebar.liveMap", icon: MapIcon },
  { href: "/planner", labelKey: "sidebar.routePlanner", icon: Cpu, roles: ["admin", "dispatcher"] },
  { href: "/dispatch", labelKey: "sidebar.dispatch", icon: CalendarClock, roles: ["admin", "dispatcher"] },
  { href: "/routes", labelKey: "sidebar.allRoutes", icon: RouteIcon },
  { href: "/routes/create", labelKey: "sidebar.createRoute", icon: PlusCircle, roles: ["admin", "dispatcher"] },
  { href: "/vehicles", labelKey: "sidebar.fleet", icon: Truck, roles: ["admin", "dispatcher"] },
  { href: "/drivers", labelKey: "sidebar.drivers", icon: Users, roles: ["admin"] },
  { href: "/stops", labelKey: "sidebar.stops", icon: MapPin, roles: ["admin", "dispatcher"] },
  { href: "/sustainability", labelKey: "sidebar.co2Dashboard", icon: Leaf },
  { href: "/analytics", labelKey: "sidebar.analytics", icon: BarChart3, roles: ["admin", "dispatcher"] },
  { href: "/webhooks", labelKey: "sidebar.webhooks", icon: Webhook, roles: ["admin"] },
  { href: "/history", labelKey: "sidebar.routeHistory", icon: Clock },
  { href: "/driver-view", labelKey: "sidebar.driverView", icon: Smartphone, roles: ["driver"] },
];

const ROLE_COLORS: Record<UserRole, string> = {
  admin: "text-red-400",
  dispatcher: "text-blue-400",
  driver: "text-emerald-400",
};

const ROLE_BG: Record<UserRole, string> = {
  admin: "bg-red-500/10",
  dispatcher: "bg-blue-500/10",
  driver: "bg-emerald-500/10",
};

export function Sidebar({ className }: { className?: string }) {
  const [location] = useLocation();
  const { t } = useTranslation();
  const { user, setUser, hasRole } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);

  const visibleItems = NAV_ITEMS.filter(item => {
    if (!item.roles) return true;
    return hasRole(...item.roles);
  });

  return (
    <aside className={cn("flex h-full flex-col bg-sidebar border-r border-sidebar-border shadow-2xl shadow-black/50 z-20", className)}>
      <div className="p-6 flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-emerald-500 flex items-center justify-center shadow-lg shadow-primary/20">
          <Command className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-display font-bold text-xl tracking-tight text-sidebar-foreground">Route<span className="text-primary">AI</span></span>
      </div>
      
      <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
        {visibleItems.map((item) => {
          const isActive = location === item.href;
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
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 mt-auto space-y-3">
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <button
            onClick={toggleTheme}
            className="flex items-center justify-center h-9 w-9 rounded-lg border border-sidebar-border bg-sidebar-accent/50 hover:bg-sidebar-accent transition-colors"
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4 text-amber-400" />
            ) : (
              <Moon className="h-4 w-4 text-indigo-500" />
            )}
          </button>
        </div>

        <div className="relative">
          <button
            onClick={() => setRoleMenuOpen(!roleMenuOpen)}
            className="w-full p-3 rounded-xl bg-gradient-to-br from-sidebar-accent/50 to-sidebar-accent border border-sidebar-border text-left group hover:border-primary/30 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className={cn("h-4 w-4", user ? ROLE_COLORS[user.role] : "")} />
                <div>
                  <p className="text-xs font-medium text-sidebar-foreground">{user?.name}</p>
                  <p className={cn("text-[10px] font-semibold uppercase tracking-wider", user ? ROLE_COLORS[user.role] : "")}>
                    {user?.role}
                  </p>
                </div>
              </div>
              <ChevronDown className={cn("h-3 w-3 text-sidebar-foreground/50 transition-transform", roleMenuOpen && "rotate-180")} />
            </div>
          </button>

          {roleMenuOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-sidebar border border-sidebar-border rounded-xl shadow-xl overflow-hidden z-50">
              {DEFAULT_USERS.map((u) => (
                <button
                  key={u.id}
                  onClick={() => { setUser(u); setRoleMenuOpen(false); }}
                  className={cn(
                    "w-full px-3 py-2.5 flex items-center gap-2 text-left text-sm hover:bg-sidebar-accent transition-colors",
                    user?.id === u.id && ROLE_BG[u.role]
                  )}
                >
                  <Shield className={cn("h-4 w-4", ROLE_COLORS[u.role])} />
                  <div>
                    <p className="text-xs font-medium text-sidebar-foreground">{u.name}</p>
                    <p className={cn("text-[10px] uppercase tracking-wider", ROLE_COLORS[u.role])}>{u.role}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
