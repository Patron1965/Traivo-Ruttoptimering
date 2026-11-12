import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanCustomerVisitsInput } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, BookMarked, CalendarDays, ChevronLeft, Loader2, Search, Star } from "lucide-react";
import { useCustomers, useCustomerMutations } from "@/hooks/use-customers";
import { localizeError } from "@/lib/localize-error";
import { cn } from "@/lib/utils";
import {
  createStopRegisterSubmission,
  filterRegister,
  groupCheckState,
  reconcileRegisterSelection,
  stopRegisterScopeKey,
  stopRegisterTargetIdentity,
  toggleSites,
  type RegisterGroup,
  type StopRegisterTarget,
} from "@/lib/stop-register";

export type { StopRegisterCommitted as StopRegisterResult } from "@/lib/stop-register";
import type { StopRegisterCommitted, StopRegisterRequest } from "@/lib/stop-register";

interface StopRegisterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: StopRegisterTarget | null;
  /** Called right before the mutation (e.g. flush autosave); returns the authoritative draft revision. */
  prepare?: () => Promise<{ draftRevision?: number }>;
  onSuccess: (result: StopRegisterCommitted) => void | Promise<void>;
}

type Phase = "select" | "confirm";

export function StopRegisterDialog({ open, onOpenChange, target, prepare, onSuccess }: StopRegisterDialogProps) {
  const { t } = useTranslation();
  const { data: customers = [], isLoading, isError, error, refetch } = useCustomers(false);
  const { planVisits } = useCustomerMutations();
  const groups: RegisterGroup[] = customers;

  const [phase, setPhase] = useState<Phase>("select");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [duplicateIds, setDuplicateIds] = useState<string[] | null>(null);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; blocking: boolean } | null>(null);
  const [hydrationFailed, setHydrationFailed] = useState(false);
  // Ambiguous failure: the server may have committed. Keep the exact attempt.
  const [unresolved, setUnresolved] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // The target (including route/draft revisions shown to the user) is frozen
  // when the dialog opens. Live polling never silently changes what is sent.
  const [frozenTarget, setFrozenTarget] = useState<StopRegisterTarget | null>(null);
  const liveIdentity = stopRegisterTargetIdentity(target);
  const identityChanged = Boolean(open && frozenTarget && liveIdentity !== stopRegisterTargetIdentity(frozenTarget));
  const scopeMoved = Boolean(open && frozenTarget && stopRegisterScopeKey(target) !== stopRegisterScopeKey(frozenTarget));

  const latest = useRef({ prepare, onSuccess, mutate: planVisits.mutateAsync });
  latest.current = { prepare, onSuccess, mutate: planVisits.mutateAsync };
  const submissionRef = useRef<ReturnType<typeof createStopRegisterSubmission> | null>(null);
  const newSubmission = () => createStopRegisterSubmission({
    prepare: () => latest.current.prepare ? latest.current.prepare() : Promise.resolve({}),
    mutate: async (request: StopRegisterRequest) => {
      const data: PlanCustomerVisitsInput = request;
      const response = await latest.current.mutate({ data });
      return { stopIds: response.stopIds, count: response.count, draftId: response.draftId, planId: response.planId };
    },
    hydrate: (result) => latest.current.onSuccess(result),
    newKey: () => crypto.randomUUID(),
  });

  useEffect(() => {
    if (!open) return;
    setPhase("select");
    setQuery("");
    setSelected(new Set());
    setDuplicateIds(null);
    setAllowDuplicates(false);
    setSubmitError(null);
    setHydrationFailed(false);
    setUnresolved(false);
    setConfirmClose(false);
    setFrozenTarget(target);
    submissionRef.current = newSubmission();
    // Only on open: freezing must not follow later prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const next = reconcileRegisterSelection(groups, selected);
    if (next.size !== selected.size) setSelected(next);
  }, [groups, selected]);

  const visible = useMemo(() => filterRegister(groups, query), [groups, query]);
  const siteById = useMemo(() => {
    const map = new Map<string, { name: string; group: string }>();
    for (const group of groups) for (const site of group.sites) map.set(site.id, { name: site.name, group: group.name });
    return map;
  }, [groups]);
  const selectedGroupCount = useMemo(
    () => groups.filter((group) => group.sites.some((site) => selected.has(site.id))).length,
    [groups, selected],
  );
  const committed = submissionRef.current?.committed ?? null;
  const locked = Boolean(committed);
  // While an attempt is unresolved, only the same object/day matters: polled
  // revision bumps (possibly from our own commit) must not block the replay.
  const scopeChanged = locked ? false : unresolved ? scopeMoved : identityChanged;
  const selectionLocked = locked || unresolved;

  const changeSelection = (next: Set<string>) => {
    if (selectionLocked) return;
    setSelected(next);
    setDuplicateIds(null);
    setAllowDuplicates(false);
    setSubmitError(null);
  };

  const finish = () => onOpenChange(false);
  const requestClose = () => {
    if (submitting) return;
    if (unresolved && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(false);
  };

  const submit = async () => {
    const submission = submissionRef.current;
    if (!frozenTarget || !submission || selected.size === 0 || submitting) return;
    if (scopeChanged) return;
    if (duplicateIds && duplicateIds.length > 0 && !allowDuplicates) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = committed
        ? await submission.retryHydration()
        : await submission.submit(frozenTarget, [...selected], Boolean(duplicateIds && allowDuplicates));
      if (!outcome || outcome.kind === "busy") return;
      setUnresolved(outcome.kind === "retryable");
      setConfirmClose(false);
      switch (outcome.kind) {
        case "scope_mismatch":
          setSubmitError({ blocking: true, message: t("stopRegister.scopeChanged") });
          return;
        case "success":
          setHydrationFailed(false);
          finish();
          return;
        case "hydration_failed":
          setHydrationFailed(true);
          setSubmitError({
            blocking: false,
            message: t("stopRegister.hydrationFailed", { count: outcome.result.count }),
          });
          return;
        case "duplicate":
          setDuplicateIds(outcome.siteIds);
          setAllowDuplicates(false);
          return;
        case "stale":
          setSubmitError({ blocking: true, message: t("stopRegister.stale") });
          return;
        case "retryable":
          setSubmitError({
            blocking: false,
            message: `${localizeError(outcome.error, t, { fallbackKey: "common.errorRequestFailed" })} ${t("stopRegister.retrySame")}`,
          });
          return;
      }
    } catch (caught) {
      // prepare() failed before anything was sent: safe to try again.
      setSubmitError({ blocking: false, message: localizeError(caught, t, { fallbackKey: "common.errorRequestFailed" }) });
    } finally {
      setSubmitting(false);
    }
  };

  const shownTarget = frozenTarget ?? target;
  const formattedDate = shownTarget?.date
    ? new Intl.DateTimeFormat("sv-SE", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${shownTarget!.date}T12:00:00`))
    : "";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) onOpenChange(true); else requestClose(); }}>
      <DialogContent className="max-w-lg gap-3 p-0 overflow-hidden" data-testid="stop-register-dialog">
        <DialogHeader className="px-5 pt-5 pb-0 space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookMarked className="h-4 w-4 text-primary" />
            {t("stopRegister.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("stopRegister.description")}
          </DialogDescription>
          {shownTarget && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-xs" data-testid="stop-register-target">
              <span className="text-muted-foreground">{t("stopRegister.target")}:</span>
              <span className="font-semibold truncate max-w-[220px]" title={shownTarget.name}>{shownTarget.name}</span>
              <span className="flex items-center gap-1 text-muted-foreground"><CalendarDays className="h-3 w-3" />{formattedDate}</span>
            </div>
          )}
        </DialogHeader>

        {phase === "select" ? (
          <>
            <div className="px-5">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("stopRegister.search")}
                  aria-label={t("stopRegister.search")}
                  className="h-8 pl-8 text-sm"
                  data-testid="input-stop-register-search"
                />
              </div>
            </div>
            <div className="traivo-scrollbar max-h-[300px] min-h-[120px] overflow-y-auto border-y bg-muted/20 px-2 py-1.5" role="group" aria-label={t("stopRegister.listLabel")}>
              {isLoading ? (
                <div className="space-y-2 p-2">
                  {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-7 w-full" />)}
                </div>
              ) : isError ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center text-sm">
                  <p className="text-destructive-text">{localizeError(error, t, { fallbackKey: "common.errorRequestFailed" })}</p>
                  <Button size="sm" variant="outline" onClick={() => void refetch()}>{t("common.retry")}</Button>
                </div>
              ) : visible.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {groups.length === 0
                    ? t("stopRegister.empty")
                    : t("stopRegister.noMatch")}
                </div>
              ) : (
                visible.map(({ group, sites }) => {
                  const state = groupCheckState(sites, selected);
                  const groupLabelId = `sr-group-${group.id}`;
                  return (
                    <div key={group.id} className="py-0.5" data-testid={`stop-register-group-${group.id}`}>
                      <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-accent/60">
                        <Checkbox
                          checked={state}
                          onCheckedChange={(checked) => changeSelection(toggleSites(selected, sites.map((site) => site.id), checked === true))}
                          aria-labelledby={groupLabelId}
                          data-testid={`checkbox-stop-register-group-${group.id}`}
                        />
                        <span id={groupLabelId} className="flex-1 truncate text-sm font-semibold">{group.name}</span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {t("stopRegister.groupCount", { count: sites.length })}
                        </span>
                      </label>
                      <ul className="ml-5 border-l pl-2">
                        {sites.map((site) => (
                          <li key={site.id}>
                            <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 hover:bg-accent/60">
                              <Checkbox
                                checked={selected.has(site.id)}
                                onCheckedChange={(checked) => changeSelection(toggleSites(selected, [site.id], checked === true))}
                                aria-label={`${site.name}, ${site.address}`}
                                data-testid={`checkbox-stop-register-site-${site.id}`}
                              />
                              <span className="min-w-0 flex-1 truncate text-[13px]">
                                {site.name}
                                <span className="ml-1.5 text-xs text-muted-foreground">{site.address}</span>
                              </span>
                              {site.isPrioritized && (
                                <span className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                                  <Star className="h-2.5 w-2.5" />{t("stopRegister.prioritized")}
                                </span>
                              )}
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>
            {scopeChanged && (
              <p className="px-5 text-xs text-destructive-text" role="alert">{t("stopRegister.scopeChanged")}</p>
            )}
            <div className="flex items-center justify-between gap-3 px-5 pb-4">
              <span className="text-xs text-muted-foreground" aria-live="polite" data-testid="text-stop-register-selection">
                {t("stopRegister.selection", { sites: selected.size, groups: selectedGroupCount })}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={requestClose}>{t("common.cancel")}</Button>
                <Button size="sm" disabled={selected.size === 0 || !shownTarget || scopeChanged} onClick={() => setPhase("confirm")} data-testid="button-stop-register-review">
                  {t("stopRegister.review")}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-3 px-5 pb-4">
            <div className="rounded-md border bg-card p-3 text-sm" data-testid="stop-register-confirmation">
              <p className="font-medium">
                {t("stopRegister.confirm", {
                  count: selected.size,
                  name: shownTarget?.name ?? "",
                  date: formattedDate,
                })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {shownTarget?.kind === "plan"
                  ? t("stopRegister.planNote")
                  : t("stopRegister.draftNote")}
              </p>
            </div>

            {duplicateIds && (
              <Alert className="border-amber-500/40 bg-amber-500/10" data-testid="stop-register-duplicate-warning">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="space-y-2 text-xs">
                  <p className="font-medium text-foreground">
                    {t("stopRegister.duplicateTitle", { count: duplicateIds.length })}
                  </p>
                  <ul className="max-h-20 overflow-y-auto list-disc pl-4">
                    {duplicateIds.map((id) => (
                      <li key={id}>{siteById.get(id)?.name ?? id}{siteById.get(id) ? ` (${siteById.get(id)!.group})` : ""}</li>
                    ))}
                  </ul>
                  <label className="flex cursor-pointer items-center gap-2 font-medium text-foreground">
                    <Checkbox checked={allowDuplicates} disabled={selectionLocked} onCheckedChange={(checked) => setAllowDuplicates(checked === true)} data-testid="checkbox-stop-register-allow-duplicates" />
                    {t("stopRegister.allowDuplicates")}
                  </label>
                </AlertDescription>
              </Alert>
            )}

            {confirmClose && (
              <Alert variant="destructive" role="alert" data-testid="stop-register-close-warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="space-y-2 text-xs">
                  <p>{t("stopRegister.closeUnresolved")}</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setConfirmClose(false)}>{t("stopRegister.keepOpen")}</Button>
                    <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => onOpenChange(false)} data-testid="button-stop-register-close-anyway">{t("stopRegister.closeAnyway")}</Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {scopeChanged && (
              <Alert variant="destructive" role="alert" data-testid="stop-register-scope-changed">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">{t("stopRegister.scopeChanged")}</AlertDescription>
              </Alert>
            )}

            {submitError && (
              <Alert variant="destructive" role="alert" data-testid="stop-register-error">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">{submitError.message}</AlertDescription>
              </Alert>
            )}

            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" disabled={submitting || selectionLocked} onClick={() => { setPhase("select"); setSubmitError(null); }}>
                <ChevronLeft className="mr-1 h-3.5 w-3.5" />{t("stopRegister.back")}
              </Button>
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={submitting || !shownTarget || scopeChanged || (!locked && !unresolved && (submitError?.blocking === true || Boolean(duplicateIds && !allowDuplicates)))}
                className={cn(duplicateIds && "bg-amber-600 hover:bg-amber-600/90 text-white")}
                data-testid="button-stop-register-submit"
              >
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {hydrationFailed
                  ? t("stopRegister.retryHydration")
                  : unresolved
                  ? t("stopRegister.retrySameButton")
                  : duplicateIds
                  ? t("stopRegister.submitDuplicates", { count: selected.size })
                  : t("stopRegister.submit", { count: selected.size })}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
