import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Route } from "@workspace/api-client-react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ImportWorkflow } from "@/pages/Import";

/** Reuse the draft's protected planning-input workflow, never a new plan. */
export function PlanOptimizationAction({ routes, enabled }: { routes: Route[]; enabled: boolean }) {
  const queryClient = useQueryClient();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planIds = new Set(routes.map(route => route.planId));
  const eligible = enabled && routes.length > 0 && planIds.size === 1 &&
    routes.every(route => route.status === "optimized" && !route.sentAt && route.handoffStatus === "pending");

  async function open() {
    if (!eligible || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/planning-drafts`, {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Planunderlaget kunde inte hämtas. Försök igen.");
      const body = await response.json() as { drafts?: { id: string; planId?: string }[] };
      const matches = body.drafts?.filter(draft => draft.planId === routes[0].planId) ?? [];
      if (matches.length !== 1) throw new Error("Planens ursprungliga underlag kunde inte identifieras entydigt.");
      setDraftId(matches[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Planunderlaget kunde inte hämtas.");
    } finally {
      setLoading(false);
    }
  }

  function close() {
    setDraftId(null);
    void queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
  }

  return <>
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" disabled={!eligible || loading} onClick={() => void open()}
        data-testid="dispatch-change-optimization-goal"
        title={eligible ? "Byt optimeringsmål och beräkna om hela den öppna planen" : "Välj en enda plan som ännu inte har skickats"}>
        <Sparkles className="h-3.5 w-3.5" />
        {loading ? "Hämtar plan…" : "Byt optimeringsmål"}
      </Button>
      {error && <p role="alert" className="max-w-sm text-xs text-destructive">{error}</p>}
    </div>
    <Dialog open={draftId !== null} onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="h-[92dvh] w-[96vw] max-w-[1400px] overflow-hidden p-0">
        <DialogTitle className="sr-only">Byt optimeringsmål för hela planen</DialogTitle>
        {draftId && <ImportWorkflow embedded draftId={draftId} optimizationRequested onComplete={close} />}
      </DialogContent>
    </Dialog>
  </>;
}
