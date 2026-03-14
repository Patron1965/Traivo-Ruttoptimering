import { useEffect, useState, useMemo } from "react";
import { Command } from "cmdk";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useRoutes } from "@/hooks/use-routes";
import { useListVehicles, useListDrivers } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";
import {
  LayoutDashboard,
  Map,
  Compass,
  Send,
  Route as RouteIcon,
  PlusCircle,
  Truck,
  Users,
  MapPin,
  Leaf,
  Clock,
  Search,
} from "lucide-react";

const NAV_PAGES = [
  { href: "/", labelKey: "sidebar.dashboard", icon: LayoutDashboard },
  { href: "/map", labelKey: "sidebar.liveMap", icon: Map },
  { href: "/planner", labelKey: "sidebar.routePlanner", icon: Compass },
  { href: "/dispatch", labelKey: "sidebar.dispatch", icon: Send },
  { href: "/routes", labelKey: "sidebar.allRoutes", icon: RouteIcon },
  { href: "/routes/create", labelKey: "sidebar.createRoute", icon: PlusCircle },
  { href: "/vehicles", labelKey: "sidebar.fleet", icon: Truck },
  { href: "/drivers", labelKey: "sidebar.drivers", icon: Users },
  { href: "/stops", labelKey: "sidebar.stops", icon: MapPin },
  { href: "/sustainability", labelKey: "sidebar.co2Dashboard", icon: Leaf },
  { href: "/history", labelKey: "sidebar.routeHistory", icon: Clock },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const { t } = useTranslation();
  const { data: routes } = useRoutes();
  const { data: vehicles } = useListVehicles({ organizationId: ORG_ID });
  const { data: drivers } = useListDrivers({ organizationId: ORG_ID });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = (path: string) => {
    navigate(path);
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999]" onClick={() => setOpen(false)}>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Command className="bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
          <div className="flex items-center gap-3 px-4 border-b border-border">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Command.Input
              placeholder={t("commandPalette.placeholder")}
              className="w-full py-3 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              autoFocus
            />
            <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-[320px] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              {t("commandPalette.noResults")}
            </Command.Empty>

            <Command.Group heading={t("commandPalette.pages")} className="text-xs font-semibold text-muted-foreground px-2 py-1.5">
              {NAV_PAGES.map((page) => (
                <Command.Item
                  key={page.href}
                  value={t(page.labelKey)}
                  onSelect={() => go(page.href)}
                  className="flex items-center gap-3 px-3 py-2 text-sm rounded-lg cursor-pointer text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
                >
                  <page.icon className="w-4 h-4 shrink-0" />
                  {t(page.labelKey)}
                </Command.Item>
              ))}
            </Command.Group>

            {routes && routes.length > 0 && (
              <Command.Group heading={t("commandPalette.routes")} className="text-xs font-semibold text-muted-foreground px-2 py-1.5">
                {routes.slice(0, 10).map((route) => (
                  <Command.Item
                    key={route.id}
                    value={route.name}
                    onSelect={() => go(`/routes/${route.id}`)}
                    className="flex items-center gap-3 px-3 py-2 text-sm rounded-lg cursor-pointer text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
                  >
                    <RouteIcon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{route.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground capitalize">{route.status}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {vehicles && vehicles.length > 0 && (
              <Command.Group heading={t("commandPalette.vehicles")} className="text-xs font-semibold text-muted-foreground px-2 py-1.5">
                {vehicles.slice(0, 8).map((v) => (
                  <Command.Item
                    key={v.id}
                    value={`${v.name} ${v.licensePlate}`}
                    onSelect={() => go("/vehicles")}
                    className="flex items-center gap-3 px-3 py-2 text-sm rounded-lg cursor-pointer text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
                  >
                    <Truck className="w-4 h-4 shrink-0" />
                    <span className="truncate">{v.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{v.licensePlate}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {drivers && drivers.length > 0 && (
              <Command.Group heading={t("commandPalette.drivers")} className="text-xs font-semibold text-muted-foreground px-2 py-1.5">
                {drivers.slice(0, 8).map((d) => (
                  <Command.Item
                    key={d.id}
                    value={d.name}
                    onSelect={() => go("/drivers")}
                    className="flex items-center gap-3 px-3 py-2 text-sm rounded-lg cursor-pointer text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
                  >
                    <Users className="w-4 h-4 shrink-0" />
                    <span className="truncate">{d.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>

          <div className="border-t border-border px-4 py-2 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{t("commandPalette.hint")}</span>
            <span>⌘K</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
