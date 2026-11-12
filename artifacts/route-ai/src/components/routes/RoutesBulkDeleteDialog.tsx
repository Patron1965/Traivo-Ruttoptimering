import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isLiveRouteRemoval, type RouteDeletionSnapshotItem } from "@/lib/route-selection";

interface RoutesBulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: RouteDeletionSnapshotItem[];
  error: string | null;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  pending: boolean;
  blocked: boolean;
  onConfirm: () => void;
}

export function RoutesBulkDeleteDialog({
  open,
  onOpenChange,
  snapshot,
  error,
  acknowledged,
  onAcknowledgedChange,
  pending,
  blocked,
  onConfirm,
}: RoutesBulkDeleteDialogProps) {
  const { t } = useTranslation();
  const liveRoutes = snapshot.filter(isLiveRouteRemoval);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("routes.bulkDeleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">{t("routes.bulkDeleteDescription", { count: snapshot.length })}</span>
            <span className="block">{t("routes.bulkDeleteRules")}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {liveRoutes.length > 0 ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
            <p className="font-semibold text-destructive">{t("routes.liveRemovalWarningTitle")}</p>
            <p className="mt-1">{t("routes.liveRemovalWarningBulk", { count: liveRoutes.length })}</p>
            <ul className="mt-2 list-disc pl-5">
              {liveRoutes.map((route) => <li key={route.routeId}>{route.name}</li>)}
            </ul>
            <p className="mt-2 text-muted-foreground">{t("routes.liveRemovalGpsLimit")}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("routes.protectedRemovalNotice")}</p>
        )}
        {liveRoutes.length > 0 && <label className="flex cursor-pointer items-start gap-2 text-sm">
          <Checkbox checked={acknowledged} onCheckedChange={(checked) => onAcknowledgedChange(checked === true)} data-testid="checkbox-bulk-acknowledge" />
          <span>{t(liveRoutes.length > 0 ? "routes.liveRemovalAcknowledge" : "routes.protectedRemovalAcknowledge")}</span>
        </label>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("common.cancel")}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || snapshot.length === 0 || blocked || (liveRoutes.length > 0 && !acknowledged)}
            onClick={onConfirm}
            data-testid="button-confirm-bulk-delete"
          >
            {pending && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {t(pending ? "routes.actionsDeleting" : "routes.deleteSelected", { count: snapshot.length })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
