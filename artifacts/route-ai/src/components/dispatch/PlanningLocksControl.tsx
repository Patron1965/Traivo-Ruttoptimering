import { useState } from "react";
import { Clock, LockKeyhole, Snowflake, Truck, Unlock } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import { usePlanningLocks } from "@/hooks/use-planning-locks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BLOCK_REASON_SV,
  buildFreezeRequest,
  buildResourceLockRequest,
  buildTimeLockRequest,
  canWritePlanningLocks,
  currentPair,
  formatStockholm,
  hasResourceLock,
  planningLockErrorGuidance,
  routeFreezeBlock,
  stopLockBlock,
  type PlanningLockRoute,
  type PlanningLockStop,
  type PlanningLocksRequest,
} from "@/lib/planning-locks";
import { LockEvidenceBadges } from "./LockEvidenceBadges";
import { stockholmPlanningMinute, stockholmPlanningMinuteToIso } from "@/lib/stockholm-planning-time";
import type { Route } from "@workspace/api-client-react";

const APPROVAL_NOTE = "Ändringen höjer planversionen och gör ett befintligt godkännande ogiltigt. Planen måste godkännas igen.";

interface PendingWrite {
  title: string;
  description: string;
  body: PlanningLocksRequest;
  testId: string;
}

function useLockWrite(routeId: string, onSaved?: (route: Route) => void | Promise<void>) {
  const mutation = usePlanningLocks();
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const confirm = () => {
    if (!pending) return;
    const { body, title } = pending;
    setPending(null);
    setLastError(null);
    mutation.mutate({ routeId, body }, {
      onSuccess: (route) => {
        toast({ title: `${title}: sparat` });
        void onSaved?.(route);
      },
      onError: (error) => {
        const msg = planningLockErrorGuidance(error.status, error.message);
        setLastError(msg);
        toast({ title: "Låset sparades inte", description: msg, variant: "destructive" });
      },
    });
  };

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>{pending?.description}</p>
              <p className="font-semibold">{APPROVAL_NOTE}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-planning-lock">Avbryt</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => { event.preventDefault(); confirm(); }}
            data-testid={`button-confirm-${pending?.testId ?? "planning-lock"}`}
          >
            Bekräfta
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const errorNode = lastError ? (
    <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive" data-testid="text-planning-lock-error">
      {lastError}
    </p>
  ) : null;

  return { mutation, setPending, dialog, errorNode };
}

export interface RouteFreezeControlProps {
  route: PlanningLockRoute;
  onSaved?: (route: Route) => void | Promise<void>;
  className?: string;
}

/** Freeze/unfreeze the whole route. Unfreeze is always allowed for writers. */
export function RouteFreezeControl({ route, onSaved, className }: RouteFreezeControlProps) {
  const auth = useAuth();
  const canWrite = canWritePlanningLocks(auth);
  const { mutation, setPending, dialog, errorNode } = useLockWrite(route.id, onSaved);
  const frozen = Boolean(route.optimizationFrozen);
  const block = routeFreezeBlock(route, canWrite);
  const disabled = mutation.isPending || block !== null;
  const label = frozen ? "Lås upp rutten" : "Frys rutten";

  return (
    <div className={cn("space-y-1.5", className)} data-testid={`control-route-freeze-${route.id}`}>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold" data-testid={`status-route-frozen-${route.id}`}>
          <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />
          {frozen ? "Fryst" : "Ej fryst"}
        </span>
        <Button
          type="button"
          size="sm"
          variant={frozen ? "secondary" : "outline"}
          className="h-8 gap-1 px-2 text-xs"
          disabled={disabled}
          aria-describedby={block ? `route-freeze-reason-${route.id}` : undefined}
          onClick={() => setPending({
            title: label,
            testId: frozen ? "route-unfreeze" : "route-freeze",
            description: frozen
              ? "Rutten blir åter optimerbar. Medlemskap, ordning, fordon–förare och planerade tider kan ändras igen."
              : "Ruttens stopp, ordning, fordon–förare-par och planerade tider fryses. Utförandehändelser tillåts fortfarande. Nya låsändringar blockeras tills rutten låses upp.",
            body: buildFreezeRequest(route, !frozen),
          })}
          data-testid={`button-${frozen ? "unfreeze" : "freeze"}-route-${route.id}`}
        >
          {frozen ? <Unlock className="h-3.5 w-3.5" aria-hidden="true" /> : <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />}
          {label}
        </Button>
      </div>
      {block && <p id={`route-freeze-reason-${route.id}`} className="text-[11px] text-muted-foreground">{BLOCK_REASON_SV[block]}</p>}
      {errorNode}
      {dialog}
    </div>
  );
}

export interface StopPlanningLocksControlProps {
  route: PlanningLockRoute;
  stop: PlanningLockStop;
  /**
   * Authoritative server service start (e.g. ScheduledStop.arrivalTime from
   * the persisted workday timeline). Pass null when unknown or estimated.
   */
  authoritativeServiceStartAt: string | null;
  vehicleName?: string;
  driverName?: string;
  onSaved?: (route: Route) => void | Promise<void>;
  className?: string;
}

/** Resource-pair and service-start lock/unlock for one selected stop. */
export function StopPlanningLocksControl({
  route,
  stop,
  authoritativeServiceStartAt,
  vehicleName,
  driverName,
  onSaved,
  className,
}: StopPlanningLocksControlProps) {
  const auth = useAuth();
  const canWrite = canWritePlanningLocks(auth);
  const { mutation, setPending, dialog, errorNode } = useLockWrite(route.id, onSaved);
  const block = stopLockBlock(route, stop, canWrite);
  const pair = currentPair(route);
  const resourceLocked = hasResourceLock(stop);
  const timeLocked = Boolean(stop.lockedServiceStartAt);
  const busy = mutation.isPending;
  const pairLabel = vehicleName ?? driverName ?? "resurs";
  const [requestedMinute, setRequestedMinute] = useState(() => stockholmPlanningMinute(stop.lockedServiceStartAt ?? authoritativeServiceStartAt));
  const requestedServiceStartAt = stockholmPlanningMinuteToIso(requestedMinute);

  const resourceReason = block
    ? BLOCK_REASON_SV[block]
    : !resourceLocked && !pair
      ? "Rutten saknar fordon–förare-par att låsa."
      : null;
  const timeReason = block
    ? BLOCK_REASON_SV[block]
    : !timeLocked && !requestedServiceStartAt
      ? "Välj en entydig minut i Stockholms tid. Tider som saknas eller förekommer två gånger vid sommartidsbyte godtas inte."
      : null;

  return (
    <section className={cn("rounded-lg border border-border px-2.5 py-2 space-y-2", className)} aria-labelledby={`planning-locks-${stop.id}`} data-testid={`control-stop-locks-${stop.id}`}>
      <div className="flex items-center justify-between gap-2">
        <h5 id={`planning-locks-${stop.id}`} className="text-[11px] font-semibold">Planeringslås</h5>
        <LockEvidenceBadges route={route} stop={stop} compact />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px]">
            <Truck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate" data-testid={`text-resource-lock-${stop.id}`}>
              {resourceLocked ? "Låst till nuvarande par" : `Nuvarande: ${pair ? pairLabel : "saknas"}`}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant={resourceLocked ? "secondary" : "ghost"}
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            disabled={busy || resourceReason !== null}
            aria-describedby={resourceReason ? `resource-reason-${stop.id}` : undefined}
            onClick={() => setPending({
              title: resourceLocked ? "Lås upp fordon och förare" : "Lås fordon och förare",
              testId: resourceLocked ? "resource-unlock" : "resource-lock",
              description: resourceLocked
                ? "Stoppet kan åter flyttas till ett annat fordon–förare-par."
                : `Stoppet låses till ${pairLabel}. Optimering och manuella flyttar får inte byta resurs.`,
              body: buildResourceLockRequest(route, stop.id, !resourceLocked),
            })}
            data-testid={`button-${resourceLocked ? "unlock" : "lock"}-resource-${stop.id}`}
          >
            {resourceLocked ? <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5" aria-hidden="true" />}
            {resourceLocked ? "Lås upp" : "Lås"}
          </Button>
        </div>
        {resourceReason && <p id={`resource-reason-${stop.id}`} className="text-[11px] text-muted-foreground">{resourceReason}</p>}
      </div>

      <div className="space-y-1 border-t border-border/60 pt-2">
        {!timeLocked && <label className="block space-y-1 text-[11px]">
          <span>Planerad servicestart (Stockholm)</span>
          <input type="datetime-local" step={60} value={requestedMinute}
            onChange={event => setRequestedMinute(event.target.value)}
            disabled={busy || Boolean(block)}
            data-testid={`input-service-start-lock-${stop.id}`}
            className="w-full rounded border border-border bg-background px-2 py-1.5" />
        </label>}
        <p className="text-[10px] text-muted-foreground">Första servicebesöket; vid hämtning och lämning avses hämtningen. Servern kontrollerar hela rutten innan tiden sparas.</p>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px]">
            <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate" data-testid={`text-time-lock-${stop.id}`}>
              {timeLocked
                ? `Servicestart låst ${formatStockholm(stop.lockedServiceStartAt)}`
                : `Servicestart: ${requestedServiceStartAt ? formatStockholm(requestedServiceStartAt) : "okänd"}`}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant={timeLocked ? "secondary" : "ghost"}
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            disabled={busy || timeReason !== null}
            aria-describedby={timeReason ? `time-reason-${stop.id}` : undefined}
            onClick={() => setPending({
              title: timeLocked ? "Lås upp servicestart" : "Lås servicestart",
              testId: timeLocked ? "time-unlock" : "time-lock",
              description: timeLocked
                ? "Servicestarten blir åter fri för omplanering."
                : `Begär exakt planerad servicestart ${formatStockholm(requestedServiceStartAt)} (Stockholmstid, ${requestedServiceStartAt}). Tiden och ruttens beräknade tider sparas bara om serverns kontroll godkänner hela ändringen. Tolerans: noll minuter.`,
              body: buildTimeLockRequest(route, stop.id, timeLocked ? null : requestedServiceStartAt),
            })}
            data-testid={`button-${timeLocked ? "unlock" : "lock"}-time-${stop.id}`}
          >
            {timeLocked ? <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5" aria-hidden="true" />}
            {timeLocked ? "Lås upp" : "Lås"}
          </Button>
        </div>
        {timeReason && <p id={`time-reason-${stop.id}`} className="text-[11px] text-muted-foreground">{timeReason}</p>}
        {!timeLocked && !timeReason && (
          <p className="text-[11px] text-muted-foreground">Låser den aktuella planerade servicestarten. Ingen omschemaläggning sker.</p>
        )}
      </div>

      {(resourceLocked || timeLocked) && !block && (
        <p className="text-[11px] text-muted-foreground">Ett befintligt lås måste låsas upp innan det kan ändras.</p>
      )}
      {errorNode}
      {dialog}
    </section>
  );
}
