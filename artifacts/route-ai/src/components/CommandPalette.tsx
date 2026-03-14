import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  Map as MapIcon,
  Truck,
  MapPin,
  Route as RouteIcon,
  Cpu,
  Leaf,
  Clock,
  Users,
  PlusCircle,
  CalendarClock,
} from "lucide-react";
import { useRoutes } from "@/hooks/use-routes";
import { useListVehicles, useListDrivers } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

const PAGES = [
  { href: "/", labelKey: "sidebar.dashboard", icon: LayoutDashboard },
  { href: "/map", labelKey: "sidebar.liveMap", icon: MapIcon },
  { href: "/planner", labelKey: "sidebar.routePlanner", icon: Cpu },
  { href: "/dispatch", labelKey: "sidebar.dispatch", icon: CalendarClock },
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

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setOpen((prev) => !prev);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const go = (path: string) => {
    navigate(path);
    setOpen(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={t("commandPalette.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("commandPalette.noResults")}</CommandEmpty>

        <CommandGroup heading={t("commandPalette.pages")}>
          {PAGES.map((page) => (
            <CommandItem key={page.href} onSelect={() => go(page.href)}>
              <page.icon className="mr-2 h-4 w-4" />
              {t(page.labelKey)}
            </CommandItem>
          ))}
        </CommandGroup>

        {routes && routes.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("commandPalette.routes")}>
              {routes.slice(0, 10).map((route) => (
                <CommandItem
                  key={route.id}
                  onSelect={() => go(`/routes/${route.id}`)}
                >
                  <RouteIcon className="mr-2 h-4 w-4" />
                  <span>{route.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground capitalize">
                    {route.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {vehicles && vehicles.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("commandPalette.vehicles")}>
              {vehicles.slice(0, 10).map((v) => (
                <CommandItem key={v.id} onSelect={() => go("/vehicles")}>
                  <Truck className="mr-2 h-4 w-4" />
                  <span>{v.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {v.licensePlate}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {drivers && drivers.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("commandPalette.drivers")}>
              {drivers.slice(0, 10).map((d) => (
                <CommandItem key={d.id} onSelect={() => go("/drivers")}>
                  <Users className="mr-2 h-4 w-4" />
                  <span>{d.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
