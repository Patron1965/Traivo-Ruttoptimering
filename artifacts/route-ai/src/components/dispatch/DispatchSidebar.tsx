import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  User,
  Truck,
  AlertTriangle,
  Package,
  MapPin,
} from "lucide-react";
import type { ScheduledRow } from "@/lib/scheduling";

interface DispatchSidebarProps {
  rows: ScheduledRow[];
  highlightedRouteId: string | null;
  onSelectRoute: (routeId: string) => void;
  unplannedCount: number;
  dropTargetRouteId?: string | null;
  isDragging?: boolean;
}

export function DispatchSidebar({
  rows,
  highlightedRouteId,
  onSelectRoute,
  unplannedCount,
  dropTargetRouteId = null,
  isDragging = false,
}: DispatchSidebarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");

  const routeRows = rows.filter((r) => r.routeId !== "unplanned");
  const unplannedRow = rows.find((r) => r.routeId === "unplanned");

  const filtered = useMemo(() => {
    if (!search.trim()) return routeRows;
    const q = search.toLowerCase();
    return routeRows.filter(
      (r) =>
        r.routeName.toLowerCase().includes(q) ||
        r.driverName.toLowerCase().includes(q) ||
        r.vehicleName.toLowerCase().includes(q),
    );
  }, [routeRows, search]);

  if (collapsed) {
    return (
      <div className="w-11 bg-card/80 border-r border-border flex flex-col items-center py-2 shrink-0">
        <button
          type="button"
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={() => setCollapsed(false)}
          aria-label={t("dispatch.expandSidebar")}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="mt-3 flex flex-col items-center gap-0">
          {routeRows.slice(0, 10).map((row) => (
            <button
              key={row.routeId}
              type="button"
              data-drop-route-id={row.routeId}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 cursor-pointer transition-all group"
              onClick={() => onSelectRoute(row.routeId)}
              aria-label={`${t("common.route", "Rutt")} ${row.routeName}`}
            >
              <span
                className={cn(
                  "w-3 h-3 rounded-full transition-all group-hover:scale-125",
                  highlightedRouteId === row.routeId && "ring-2 ring-white scale-125",
                  dropTargetRouteId === row.routeId && "ring-2 ring-primary scale-150"
                )}
                style={{ backgroundColor: row.color }}
              />
            </button>
          ))}
          {routeRows.length > 10 && (
            <span className="text-[8px] text-muted-foreground">
              +{routeRows.length - 10}
            </span>
          )}
        </div>
        {unplannedCount > 0 && (
          <div className="mt-auto mb-2">
            <div className="w-5 h-5 rounded-full bg-destructive/20 flex items-center justify-center">
              <span className="text-[8px] font-bold text-destructive">
                {unplannedCount}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-[280px] bg-card/80 border-r border-border flex flex-col shrink-0 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {t("dispatch.routesSidebar")}
        </span>
        <button
          type="button"
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={() => setCollapsed(true)}
          aria-label={t("dispatch.collapseSidebar")}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="px-2 py-1.5 border-b border-border/30">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("dispatch.searchRoutes")}
            className="w-full h-7 pl-7 pr-2 text-xs bg-muted/50 border border-border/50 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>

      {isDragging && (
        <div className="px-3 py-1.5 bg-primary/10 border-b border-primary/30 text-[10px] font-semibold text-primary flex items-center gap-1.5">
          <MapPin className="h-3 w-3" />
          {t("dispatch.dropHint", "Släpp på en rutt nedan för att flytta")}
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {filtered.map((row) => {
          const isHighlighted = highlightedRouteId === row.routeId;
          const isDropTarget = dropTargetRouteId === row.routeId;
          const overCap = row.capacityPercent > 100;
          return (
            <button
              key={row.routeId}
              type="button"
              data-drop-route-id={row.routeId}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2.5 border-b border-border/20 text-left transition-all cursor-pointer hover:bg-muted/50",
                isHighlighted && "bg-primary/10 border-l-2 border-l-primary",
                isDropTarget && "bg-primary/25 ring-2 ring-inset ring-primary scale-[1.01]",
                isDragging && !isDropTarget && "hover:bg-primary/10",
              )}
              onClick={() => onSelectRoute(row.routeId)}
            >
              <div
                className="w-3 h-3 rounded-full shrink-0 mt-0.5"
                style={{ backgroundColor: row.color }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold truncate">{row.routeName}</p>
                <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                  <User className="h-2.5 w-2.5 shrink-0" />
                  {row.driverName}
                  <span className="mx-0.5 opacity-50">·</span>
                  <Truck className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{row.vehicleName}</span>
                </p>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                <span className="text-[10px] text-muted-foreground font-mono">
                  {row.stops.length}
                </span>
                <span
                  className={cn(
                    "text-[10px] font-bold px-1 py-0.5 rounded",
                    overCap
                      ? "bg-destructive/20 text-destructive"
                      : "bg-primary/10 text-primary",
                  )}
                >
                  {overCap && (
                    <AlertTriangle className="h-2.5 w-2.5 inline mr-0.5" />
                  )}
                  {row.capacityPercent.toFixed(0)}%
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {(
        <button
          type="button"
          data-drop-route-id="unplanned"
          onClick={() => onSelectRoute("unplanned")}
          className={cn(
            "border-t border-border px-3 py-2.5 bg-destructive/5 text-left transition-all w-full cursor-pointer hover:bg-destructive/10",
            dropTargetRouteId === "unplanned" && "bg-destructive/20 ring-2 ring-inset ring-destructive",
          )}
        >
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-destructive shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-destructive">
                {t("dispatch.unplannedStops")}
              </p>
              <p className="text-[10px] text-destructive/70 mt-0.5">
                {t("dispatch.unplannedHint", "Släpp här för att avschemalägga")}
              </p>
            </div>
            <span className="text-xs font-bold bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">
              {unplannedCount}
            </span>
          </div>
        </button>
      )}
    </div>
  );
}

