import { useState } from "react";
import { Maximize2, MessageSquare, Minimize2, Truck, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { routeDisplayName } from "@/lib/chat-display";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RouteMessageThread } from "./RouteMessageThread";
import { StopMessageThread } from "./StopMessageThread";

export interface ChatStopContext {
  stopId: string;
  sequenceOrder?: number | null;
  address?: string | null;
  label?: string | null;
}

export function stopContextLabel(stop: ChatStopContext): string {
  const num = stop.sequenceOrder != null ? `stopp ${stop.sequenceOrder}` : "stoppet";
  return stop.address ? `${num}, ${stop.address}` : num;
}

/**
 * Planner chat with an explicit scope switch. Both threads stay mounted so
 * drafts and pending sends are never mixed or discarded when switching.
 */
export function DispatchChatPanel({
  routeId, stop, driverName, vehicleName, routeLabel, readOnly = false, stopChoices, onChooseStop,
}: {
  routeId: string;
  stop: ChatStopContext | null;
  driverName?: string;
  vehicleName?: string;
  routeLabel?: string;
  readOnly?: boolean;
  stopChoices?: ChatStopContext[];
  onChooseStop?: (stopId: string) => void;
}) {
  const [scope, setScope] = useState<"route" | "stop">(stop ? "stop" : "route");
  const [expanded, setExpanded] = useState(false);
  const recipient = driverName || "chauffören";
  const canChoose = !stop && !!onChooseStop && !!stopChoices?.length;

  const safeRouteLabel = routeDisplayName(routeLabel);

  const header = (
    <header className="border-b border-border bg-muted/25 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <h5 className="truncate text-[11px] font-bold">Chatt med {recipient}</h5>
        </div>
        <button type="button" onClick={() => setExpanded((v) => !v)} data-testid="button-toggle-chat-expand"
          aria-label={expanded ? "Minska chatten" : "Förstora chatten"} title={expanded ? "Minska (Esc)" : "Förstora"}
          className="mr-6 inline-flex h-7 items-center gap-1 rounded px-1.5 text-[10px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          {expanded ? "Minska" : "Förstora"}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground" data-testid="text-chat-recipient">
        <span className="inline-flex items-center gap-1"><User className="h-3 w-3" />{driverName || "Ingen chaufför"}</span>
        <span className="inline-flex items-center gap-1"><Truck className="h-3 w-3" />{vehicleName || "Inget fordon"}</span>
        {safeRouteLabel && <span>Rutt {safeRouteLabel}</span>}
      </div>
      <div role="tablist" aria-label="Välj chatt" className="mt-2 grid grid-cols-2 rounded-md border border-border bg-background p-0.5 text-[11px] font-semibold">
        <button type="button" role="tab" aria-selected={scope === "route"} onClick={() => setScope("route")}
          data-testid="tab-chat-route"
          className={cn("rounded px-2 py-1 transition-colors", scope === "route" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
          Hela rutten
        </button>
        <button type="button" role="tab" aria-selected={scope === "stop"} onClick={() => setScope("stop")}
          data-testid="tab-chat-stop"
          className={cn("rounded px-2 py-1 transition-colors", scope === "stop" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
          Detta stopp{stop?.sequenceOrder != null ? ` (${stop.sequenceOrder})` : ""}
        </button>
      </div>
      {scope === "stop" && stop && (
        <p className="mt-1.5 text-[10px] font-medium text-foreground" data-testid="text-chat-stop-context">
          {stopContextLabel(stop)}
        </p>
      )}
    </header>
  );

  // Only one copy of the threads is mounted at a time (inline or dialog). Drafts and pending
  // sends live in module stores keyed by actor+scope, so moving between them loses nothing.
  // Only the visible scope polls and marks messages read.
  const threads = (
    <div className={cn(expanded && "min-h-0 flex-1 overflow-y-auto")}>
      <div hidden={scope !== "route"}>
        <RouteMessageThread routeId={routeId} readOnly={readOnly} expanded={expanded} recipientLabel={driverName}
          active={scope === "route"} />
      </div>
      <div hidden={scope !== "stop"}>
        {stop ? (
          <StopMessageThread key={stop.stopId} stopId={stop.stopId} readOnly={readOnly} expanded={expanded}
            contextLabel={stopContextLabel(stop)} active={scope === "stop"} />
        ) : canChoose ? (
          <div className="space-y-1 px-2.5 py-2.5" data-testid="chat-stop-picker">
            <p className="text-[11px] text-muted-foreground">Välj vilket stopp meddelandet gäller:</p>
            <div className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded border border-border">
              {stopChoices!.map((s) => (
                <button key={s.stopId} type="button" onClick={() => onChooseStop!(s.stopId)}
                  data-testid={`button-chat-choose-stop-${s.stopId}`}
                  className="block w-full px-2 py-1.5 text-left text-[11px] hover:bg-muted">
                  <span className="font-semibold tabular-nums">{s.sequenceOrder ?? "–"}</span>
                  <span className="ml-2 text-muted-foreground">{s.address ?? s.label ?? ""}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="px-2.5 py-3 text-[11px] text-muted-foreground" data-testid="text-chat-no-stop">
            Inget stopp är valt. Välj ett stopp i listan eller på kartan för att skriva om just det stoppet, eller använd Hela rutten.
          </p>
        )}
      </div>
    </div>
  );

  return (
    <>
      <section className="overflow-hidden rounded-lg border border-border bg-card" data-testid="dispatch-chat-panel" aria-label="Chatt med chauffören">
        {expanded ? (
          <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5 text-primary" />Chatten är förstorad.</span>
            <button type="button" onClick={() => setExpanded(false)} className="font-semibold text-foreground underline"
              data-testid="button-chat-restore">Visa här</button>
          </div>
        ) : (<>{header}{threads}</>)}
      </section>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[min(86vh,760px)] w-[min(640px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
          data-testid="dialog-chat-expanded">
          <DialogTitle className="sr-only">Chatt med {recipient}</DialogTitle>
          <DialogDescription className="sr-only">Förstorad chatt för rutten och valt stopp. Stäng med Escape.</DialogDescription>
          {expanded && header}
          {expanded && threads}
        </DialogContent>
      </Dialog>
    </>
  );
}
