import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Download, ExternalLink, LoaderCircle, MapPin, MoreHorizontal, Trash2, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getExportRouteUrl, type Route } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { localizeError } from "@/lib/localize-error";
import { useDeleteRoute } from "@/hooks/use-routes";
import { isLiveRouteRemoval } from "@/lib/route-selection";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";

export function RouteActionsMenu({ route, identity, onPreview, onDeleted, deleteDisabled = false }: {
  route: Route;
  identity: string;
  onPreview: () => void;
  onDeleted: () => void;
  deleteDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const { user, hasRole } = useAuth();
  const deletion = useDeleteRoute();
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveAcknowledged, setLiveAcknowledged] = useState(false);
  const [confirmationSnapshot, setConfirmationSnapshot] = useState<string | null>(null);
  const canWrite = hasRole("admin", "dispatcher");
  const isLive = isLiveRouteRemoval(route);
  const currentConfirmationState = `${route.status}:${route.handoffStatus}:${route.planRevision}`;

  useEffect(() => {
    if (!confirmOpen || confirmationSnapshot === currentConfirmationState) return;
    setConfirmOpen(false);
    setLiveAcknowledged(false);
    setConfirmationSnapshot(null);
    setError(t("routes.actionsDeleteChanged"));
  }, [confirmOpen, confirmationSnapshot, currentConfirmationState, t]);

  async function exportCsv() {
    setError(null);
    setExporting(true);
    try {
      const response = await fetch(`${getExportRouteUrl(route.id)}?organizationId=${encodeURIComponent(user!.organizationId)}`, { credentials: "include" });
      if (!response.ok) throw { status: response.status };
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${route.name || route.id}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(localizeError(cause, t, { fallbackKey: "routes.actionsExportError" }));
    } finally {
      setExporting(false);
    }
  }

  async function remove() {
    setError(null);
    try {
      await deletion.mutateAsync({ id: route.id, confirmLiveRouteRemoval: liveAcknowledged });
      setConfirmOpen(false);
      onDeleted();
    } catch (cause) {
      setError(localizeError(cause, t, { fallbackKey: "routes.bulkDeleteError" }));
    }
  }

  return (
    <div data-route-action onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} variant="ghost" className="min-h-11 gap-2 text-muted-foreground"
            data-testid={`button-route-actions-${route.id}`}
            aria-label={t("routes.actionsFor", { name: identity })}>
            {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <MoreHorizontal className="h-4 w-4" aria-hidden />}
            {t("routes.actions")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]" onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!confirmOpen) trigger.current?.focus();
        }}>
          <DropdownMenuItem className="min-h-11" onSelect={onPreview} data-testid={`button-preview-route-${route.id}`}>
            <MapPin className="mr-2 h-4 w-4" />{t("routes.previewRoute")}
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="min-h-11">
            <Link href={`/routes/${route.id}`} data-testid={`link-open-route-${route.id}`}>
              <ExternalLink className="mr-2 h-4 w-4" />{t("routes.openRoute", { name: route.name })}
            </Link>
          </DropdownMenuItem>
          {canWrite && route.vehicleId && <DropdownMenuItem asChild className="min-h-11">
            <Link href="/vehicles" data-testid={`link-manage-vehicle-${route.id}`}>
              <User className="mr-2 h-4 w-4" />{t("routes.manageVehicleAssignment")}
            </Link>
          </DropdownMenuItem>}
          <DropdownMenuItem className="min-h-11" disabled={exporting} onSelect={() => void exportCsv()} data-testid={`link-export-route-${route.id}`}>
            <Download className="mr-2 h-4 w-4" />{t("common.exportCsv")}
          </DropdownMenuItem>
          {canWrite && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11 text-destructive focus:text-destructive" disabled={deleteDisabled || deletion.isPending} data-testid={`button-delete-route-${route.id}`}
              onSelect={() => {
                setError(null);
                setLiveAcknowledged(false);
                setConfirmationSnapshot(currentConfirmationState);
                setConfirmOpen(true);
              }}>
              <Trash2 className="mr-2 h-4 w-4" />{t("common.delete")}
            </DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
      {exporting && <span role="status" className="text-xs text-muted-foreground">{t("routes.actionsExporting")}</span>}
      {error && !confirmOpen && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialog open={confirmOpen} onOpenChange={(open) => {
        if (!deletion.isPending) {
          setConfirmOpen(open);
          if (!open) {
            setError(null);
            setLiveAcknowledged(false);
            setConfirmationSnapshot(null);
          }
        }
      }}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg" onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }} onEscapeKeyDown={(event) => { if (deletion.isPending) event.preventDefault(); }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("routes.actionsDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {t("routes.actionsDeleteDescription", { name: identity })}
            </AlertDialogDescription>
            {isLive && (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
                <p className="font-semibold text-destructive">{t("routes.liveRemovalWarningTitle")}</p>
                <p className="mt-1">{t("routes.liveRemovalWarningSingle", { name: route.name })}</p>
                <p className="mt-1 text-muted-foreground">{t("routes.liveRemovalGpsLimit")}</p>
              </div>
            )}
            {!isLive && <p className="mt-3 text-sm text-muted-foreground">{t("routes.protectedRemovalNotice")}</p>}
            {isLive && <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox checked={liveAcknowledged} onCheckedChange={(checked) => setLiveAcknowledged(checked === true)} />
              <span>{t(isLive ? "routes.liveRemovalAcknowledge" : "routes.protectedRemovalAcknowledge")}</span>
            </label>}
          </AlertDialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletion.isPending}>{t("common.cancel")}</AlertDialogCancel>
              <Button variant="destructive" disabled={deletion.isPending || !canWrite || deleteDisabled || (isLive && !liveAcknowledged)} onClick={() => void remove()}>
              {deletion.isPending && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {t(deletion.isPending ? "routes.actionsDeleting" : "common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}