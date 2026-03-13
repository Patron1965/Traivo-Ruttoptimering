import { X, MapPin, Clock, Truck, Weight, Package, Navigation, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { ScheduledStop } from "@/lib/scheduling";

interface StopDetailPanelProps {
  stop: ScheduledStop | null;
  routeColor: string;
  driverName?: string;
  vehicleName?: string;
  onClose: () => void;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function StopDetailPanel({
  stop,
  routeColor,
  driverName,
  vehicleName,
  onClose,
}: StopDetailPanelProps) {
  const { t } = useTranslation();

  if (!stop) return null;

  return (
    <div className="w-[340px] bg-card border-l border-border flex flex-col h-full overflow-hidden animate-in slide-in-from-right-5 duration-200">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: routeColor }}
          />
          <h3 className="font-bold text-sm truncate">
            {t("dispatch.stopDetails")}
          </h3>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span
              className="w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center shrink-0"
              style={{ backgroundColor: routeColor }}
            >
              {stop.sequenceOrder}
            </span>
            <h4 className="font-bold text-base truncate">
              {stop.customerName || stop.address}
            </h4>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{stop.address}</span>
          </p>
        </div>

        {(driverName || vehicleName) && (
          <div className="grid grid-cols-2 gap-2">
            {vehicleName && (
              <DetailCard
                icon={<Truck className="h-3.5 w-3.5" />}
                label={t("dispatch.vehicle")}
                value={vehicleName}
              />
            )}
            {driverName && (
              <DetailCard
                icon={<User className="h-3.5 w-3.5" />}
                label={t("dispatch.driver")}
                value={driverName}
              />
            )}
          </div>
        )}

        <div className="bg-muted/30 rounded-xl p-3 space-y-2.5">
          <h5 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {t("dispatch.schedule")}
          </h5>
          <div className="grid grid-cols-2 gap-2">
            <DetailCard
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.arrival")}
              value={formatTime(stop.arrivalTime)}
            />
            <DetailCard
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.departure")}
              value={formatTime(stop.departureTime)}
            />
          </div>
          {stop.timeWindowStart && (
            <DetailCard
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.timeWindow")}
              value={`${new Date(stop.timeWindowStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${stop.timeWindowEnd ? ` – ${new Date(stop.timeWindowEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`}
            />
          )}
        </div>

        <div className="bg-muted/30 rounded-xl p-3 space-y-2.5">
          <h5 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {t("dispatch.travelInfo")}
          </h5>
          <div className="grid grid-cols-2 gap-2">
            <DetailCard
              icon={<Navigation className="h-3.5 w-3.5" />}
              label={t("dispatch.distance")}
              value={`${stop.distanceFromPrevKm.toFixed(1)} km`}
            />
            <DetailCard
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.travelTime")}
              value={`${Math.round(stop.travelTimeMin)} min`}
            />
            <DetailCard
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.serviceTime")}
              value={`${stop.serviceDurationMin} min`}
            />
          </div>
        </div>

        <div className="bg-muted/30 rounded-xl p-3 space-y-2.5">
          <h5 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {t("dispatch.loadInfo")}
          </h5>
          <div className="grid grid-cols-2 gap-2">
            <DetailCard
              icon={<Weight className="h-3.5 w-3.5" />}
              label={t("common.weight")}
              value={`${stop.weightKg} kg`}
            />
            <DetailCard
              icon={<Package className="h-3.5 w-3.5" />}
              label={t("common.volume")}
              value={`${stop.volumeM3} m³`}
            />
          </div>
        </div>

        {stop.trackingCode && (
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <span className="font-mono bg-muted px-2 py-1 rounded">
              {stop.trackingCode}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-card rounded-lg p-2 border border-border/50">
      <div className="flex items-center gap-1 text-muted-foreground mb-0.5">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-sm font-semibold truncate">{value}</p>
    </div>
  );
}
