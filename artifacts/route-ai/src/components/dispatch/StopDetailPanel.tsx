import {
  X,
  MapPin,
  Clock,
  Truck,
  Weight,
  Package,
  Navigation,
  User,
  Phone,
  Mail,
  FileText,
  Camera,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useGetRouteStops, getGetRouteStopsQueryKey, useGetStopProofs, getGetStopProofsQueryKey } from "@workspace/api-client-react";
import { ProofDisplay } from "@/components/pod/ProofDisplay";
import { ProofPreview } from "@/components/pod/ProofPreview";
import type { ScheduledStop } from "@/lib/scheduling";
import type { NearbyStop } from "@/lib/nearby-stops";
import { DispatchChatPanel } from "./DispatchChatPanel";
import { CustomerLinkControls } from "@/components/CustomerLinkControls";
import {
  LockedFirstStopControl,
  type LockedFirstStopControlProps,
} from "@/components/routes/LockedFirstStopControl";
import { StopPlanningLocksControl, type StopPlanningLocksControlProps } from "./PlanningLocksControl";

interface StopDetailPanelProps {
  stop: ScheduledStop | null;
  routeId?: string;
  routeLabel?: string;
  organizationId?: string;
  routeColor: string;
  driverName?: string;
  vehicleName?: string;
  hasDispatchedDriver?: boolean;
  readOnlyMessages?: boolean;
  firstStopLock?: Omit<LockedFirstStopControlProps, "className" | "compact">;
  planningLocks?: Omit<StopPlanningLocksControlProps, "className">;
  correctionPanel?: ReactNode;
  nearbyStops: NearbyStop[];
  onSelectNearbyStop: (stopId: string) => void;
  onClose: () => void;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatOptionalTime(date: Date | undefined, missingLabel: string) {
  return date ? formatTime(date) : missingLabel;
}
export function StopDetailPanel({
  stop,
  routeId,
  routeLabel,
  organizationId,
  routeColor,
  driverName,
  vehicleName,
  hasDispatchedDriver = true,
  readOnlyMessages = false,
  firstStopLock,
  planningLocks,
  correctionPanel,
  nearbyStops,
  onSelectNearbyStop,
  onClose,
}: StopDetailPanelProps) {
  const { t } = useTranslation();
  const { data: arrivalStops } = useGetRouteStops(routeId ?? "", {
    query: { queryKey: getGetRouteStopsQueryKey(routeId ?? ""), enabled: !!routeId && !!stop, refetchInterval: 15_000 },
  });
  const arrival = arrivalStops?.find(item => item.id === stop?.stopId)?.arrival ?? stop?.arrival;
  const currentStop = arrivalStops?.find(item => item.id === stop?.stopId);
  const proofParams = { organizationId: organizationId ?? "" };
  const { data: proofs } = useGetStopProofs(stop?.stopId ?? "", proofParams, {
    query: { queryKey: getGetStopProofsQueryKey(stop?.stopId ?? "", proofParams),
      enabled: !!stop && !!organizationId && !readOnlyMessages, refetchInterval: 15_000 },
  });

  if (!stop) return null;
  const timingVerified = Boolean(stop.arrivalTime && stop.departureTime);

  const orderReference =
    stop.externalRef || stop.shopifyOrderName || stop.trackingCode;
  const hasOrderData = Boolean(
    orderReference ||
      stop.contactName ||
      stop.contactPhone ||
      stop.contactEmail ||
      stop.notes,
  );

  return (
    <div
      className="w-[320px] bg-card border-l border-border flex flex-col h-full overflow-hidden animate-in slide-in-from-right-5 duration-200"
      data-testid="dispatch-stop-detail-panel"
    >
      <div className="px-3 py-2"><CustomerLinkControls stopId={stop.stopId} /></div>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: routeColor }}
          />
          <h3 className="font-bold text-[13px] truncate">
            {t("dispatch.stopDetails")}
          </h3>
        </div>
        <Button variant="ghost" size="icon" className="h-[44px] w-[44px]" onClick={onClose} aria-label={t("common.close")}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 pb-16 space-y-3">
        <div>
          <div className="flex items-center gap-2">
            <span
              className="w-6 h-6 rounded-full text-white text-[11px] font-bold flex items-center justify-center shrink-0"
              style={{ backgroundColor: routeColor }}
            >
              {stop.sequenceOrder}
            </span>
            <h4 className="font-bold text-[15px] leading-tight truncate">
              {stop.contactName || stop.customerName || stop.address}
            </h4>
          </div>
          {firstStopLock && (
            <div className="mt-2 pl-8">
              <LockedFirstStopControl
                {...firstStopLock}
                className="w-full justify-start"
              />
            </div>
          )}
          <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1 pl-8">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{stop.address}</span>
          </p>
        </div>

        {planningLocks && <StopPlanningLocksControl key={`${planningLocks.route.id}:${planningLocks.stop.id}`} {...planningLocks} />}
        {correctionPanel && <details className="border-b border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold">Rätta uppdrag eller föreslå resurs</summary>
          <div className="pt-3">{correctionPanel}</div>
        </details>}
        <section className="rounded-lg border border-border px-2.5 py-2" data-testid="dispatch-driver-arrival">
          <h5 className="text-[11px] font-semibold">Chaufförens beräknade ankomst</h5>
          <p className="text-sm">
            {arrival?.estimatedAt ? new Date(arrival.estimatedAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) : "Ej tillgänglig"}
          </p>
          {arrival?.estimatedAt && (
            <p className="text-[11px] text-muted-foreground">
              {arrival.source === "plan_shift" ? "Förskjutning av planerad tid" : "Vägbaserad uppskattning"}.
              {" "}Uppdaterad {arrival.calculatedAt ? new Date(arrival.calculatedAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) : "okänd tid"}.
              {arrival.positionAt && Date.now() - Date.parse(arrival.positionAt) > 120_000 ? " Äldre position." : ""}
            </p>
          )}
        </section>
        {currentStop && ["completed", "failed", "skipped"].includes(currentStop.status) && (
          <section className="rounded-lg border border-border px-2.5 py-2" data-testid="dispatch-recorded-completion">
            <h5 className="text-[11px] font-semibold">
              {currentStop.status === "completed" ? "Faktiskt genomförd" : "Faktiskt rapporterad"}
            </h5>
            <p className="text-sm tabular-nums" data-testid="text-recorded-completion-time">
              {currentStop.terminalAt
                ? new Date(currentStop.terminalAt).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                : "Tid ej registrerad"}
            </p>
            <p className="text-[11px] text-muted-foreground">Registrerad tid i svensk tid, skild från planerad ankomst och avgång nedan.</p>
          </section>
        )}
        {(currentStop?.executionComment || !!proofs?.length) && (
          <section className="rounded-lg border border-border px-2.5 py-2" data-testid="dispatch-driver-report">
            <div className="flex items-center justify-between gap-2">
              <h5 className="text-[11px] font-semibold">Chaufförens rapport</h5>
              {!!proofs?.length && (
                <ProofPreview key={stop.stopId} proofs={proofs} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold" testId="status-proof-on-file">
                  <Camera className="h-3 w-3" />
                  {[proofs.some(p => p.proofType === "photo") && "Foto", proofs.some(p => p.proofType === "signature") && "Signatur"].filter(Boolean).join(" + ") || "Bevis"}
                </ProofPreview>
              )}
            </div>
            {currentStop?.executionComment && <p className="mt-2 whitespace-pre-wrap text-xs">{currentStop.executionComment}</p>}
            {!!proofs?.length && <ProofDisplay key={stop.stopId} proofs={proofs.map(proof => ({
              ...proof, fileUrl: proof.fileUrl ?? null, data: proof.data ?? null,
            }))} compact />}
          </section>
        )}
        <section className="rounded-lg border border-border px-2.5 py-2" data-testid="dispatch-nearby-stops">
          <h5 className="text-[11px] font-semibold">Närliggande stopp inom 50 m (fågelvägen)</h5>
          {nearbyStops.length ? (
            <div className="mt-1 divide-y divide-border/60">
              {nearbyStops.map(({ stop: nearby }) => (
                <button
                  key={nearby.stopId}
                  type="button"
                  className="block w-full rounded px-0.5 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onSelectNearbyStop(nearby.stopId)}
                  aria-label={`Visa stopp ${nearby.sequenceOrder}: ${nearby.externalRef || nearby.shopifyOrderName || nearby.trackingCode || nearby.customerName || nearby.address}`}
                >
                  <span className="flex items-center gap-2 text-xs font-semibold min-w-0">
                    <span className="flex h-6 min-w-6 items-center justify-center rounded border border-border px-1 tabular-nums shrink-0">{nearby.sequenceOrder}</span>
                    <span className="truncate">{nearby.externalRef || nearby.shopifyOrderName || nearby.trackingCode || nearby.customerName || nearby.stopId}</span>
                  </span>
                  <span className="block pl-8 text-[11px] text-muted-foreground truncate">{nearby.address}</span>
                </button>
              ))}
            </div>
          ) : <p className="mt-1 text-[11px] text-muted-foreground">Inga andra stopp inom 50 m.</p>}
        </section>

        <section
          className="rounded-lg border border-border bg-muted/20 overflow-hidden"
          data-testid="dispatch-stop-order-data"
        >
          <div className="px-2.5 py-1.5 border-b border-border/70 flex items-center justify-between gap-2">
            <h5 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("dispatch.orderData")}
            </h5>
            {orderReference && (
              <span className="font-mono text-[10px] font-semibold text-foreground bg-background border border-border rounded px-1.5 py-0.5 max-w-[165px] truncate">
                {orderReference}
              </span>
            )}
          </div>
          <div className="divide-y divide-border/60">
            {stop.contactName && (
              <CompactRow
                icon={<User className="h-3.5 w-3.5" />}
                label={t("dispatch.recipient")}
                value={stop.contactName}
              />
            )}
            {stop.contactPhone && (
              <CompactRow
                icon={<Phone className="h-3.5 w-3.5" />}
                label={t("dispatch.phone")}
                value={stop.contactPhone}
                href={`tel:${stop.contactPhone}`}
              />
            )}
            {stop.contactEmail && (
              <CompactRow
                icon={<Mail className="h-3.5 w-3.5" />}
                label={t("dispatch.email")}
                value={stop.contactEmail}
                href={`mailto:${stop.contactEmail}`}
              />
            )}
            {stop.notes && (
              <CompactRow
                icon={<FileText className="h-3.5 w-3.5" />}
                label={t("dispatch.deliveryInstructions")}
                value={stop.notes}
                multiline
              />
            )}
            {!hasOrderData && (
              <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
                {t("dispatch.noOrderData")}
              </p>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-border overflow-hidden">
          {stop.isEstimated && (
            <div
              className="border-b border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
              data-testid="dispatch-estimated-stop-time"
            >
              {t(
                "dispatch.estimatedStopTime",
                "Beräknad stopptid – arbetsdagen behöver räknas om och valideras.",
              )}
            </div>
          )}
          <div className="grid grid-cols-2 divide-x divide-border">
            <Metric
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.arrival")}
              value={formatOptionalTime(stop.arrivalTime, t("dispatch.scheduleNeedsRecalculationShort"))}
            />
            <Metric
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.departure")}
              value={formatOptionalTime(stop.departureTime, t("dispatch.scheduleNeedsRecalculationShort"))}
            />
          </div>
          <div className="grid grid-cols-3 border-t border-border divide-x divide-border">
            <Metric
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t("dispatch.timeWindow")}
              value={
                stop.timeWindowStart
                  ? `${formatTime(new Date(stop.timeWindowStart))}${stop.timeWindowEnd ? `–${formatTime(new Date(stop.timeWindowEnd))}` : ""}`
                  : "—"
              }
            />
            <Metric
              icon={<Weight className="h-3.5 w-3.5" />}
              label={t("common.weight")}
              value={`${stop.weightKg} kg`}
            />
            <Metric
              icon={<Package className="h-3.5 w-3.5" />}
              label={t("common.volume")}
              value={`${stop.volumeM3} m³`}
            />
          </div>
        </section>

        <div className="rounded-lg bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground space-y-1.5">
          {!timingVerified && (
            <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 font-semibold text-amber-700 dark:text-amber-300">
              {t("dispatch.scheduleNeedsRecalculation")}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1 min-w-0">
              <User className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{driverName || t("dispatch.unassigned")}</span>
            </span>
            <span className="flex items-center gap-1 min-w-0">
              <Truck className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{vehicleName || t("dispatch.noVehicle")}</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-1.5">
            <span className="flex items-center gap-1">
              <Navigation className="h-3.5 w-3.5" />
              {stop.distanceFromPrevKm !== undefined && stop.travelTimeMin !== undefined
                ? `${stop.distanceFromPrevKm.toFixed(1)} km · ${Math.round(stop.travelTimeMin)} min`
                : t("dispatch.scheduleNeedsRecalculationShort")}
            </span>
            <span>{t("dispatch.serviceTime")} {stop.serviceDurationMin} min</span>
          </div>
        </div>

        {hasDispatchedDriver && routeId && (
          <DispatchChatPanel
            routeLabel={routeLabel}
            routeId={routeId}
            stop={{ stopId: stop.stopId, sequenceOrder: stop.sequenceOrder, address: stop.address }}
            driverName={driverName}
            vehicleName={vehicleName}
            readOnly={readOnlyMessages}
          />
        )}
      </div>
    </div>
  );
}

function CompactRow({
  icon,
  label,
  value,
  href,
  multiline = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href?: string;
  multiline?: boolean;
}) {
  const content = (
    <span className={multiline ? "text-right leading-snug whitespace-pre-wrap" : "truncate text-right"}>
      {value}
    </span>
  );

  return (
    <div className="grid grid-cols-[minmax(0,96px)_minmax(0,1fr)] gap-2 px-2.5 py-1.5 text-[11px]">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {href ? (
        <a className="font-medium text-primary hover:underline truncate text-right" href={href}>
          {value}
        </a>
      ) : (
        <span className="font-medium min-w-0">{content}</span>
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="px-2 py-1.5 min-w-0">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-0.5 text-xs font-semibold truncate">{value}</p>
    </div>
  );
}
