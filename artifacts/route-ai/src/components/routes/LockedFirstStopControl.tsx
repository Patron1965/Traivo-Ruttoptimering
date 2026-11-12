import { useState } from "react";
import { LockKeyhole, Unlock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { localizeError } from "@/lib/localize-error";
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
import { useLockedFirstStop } from "@/hooks/use-locked-first-stop";
import type { Route } from "@workspace/api-client-react";

export interface LockedFirstStopControlProps {
  routeId: string;
  planRevision: number;
  routeStatus?: string | null;
  lockedFirstStopId?: string | null;
  stopId: string;
  stopStatus?: string | null;
  stopRouteId?: string | null;
  hasUnsavedLocalChanges?: boolean;
  onSaved?: (route: Route) => void | Promise<void>;
  className?: string;
  /** Use a compact icon button in dense stop lists. */
  compact?: boolean;
}

const EDITABLE_ROUTE_STATUSES = new Set(["draft", "optimized"]);

/**
 * Shared first-stop lock affordance for route detail, Dispatch and imported
 * plan adjustment surfaces. It only exposes a write for a pending assigned
 * stop on a planning-stage route.
 */
export function LockedFirstStopControl({
  routeId,
  planRevision,
  routeStatus,
  lockedFirstStopId = null,
  stopId,
  stopStatus,
  stopRouteId,
  hasUnsavedLocalChanges = false,
  onSaved,
  className,
  compact = false,
}: LockedFirstStopControlProps) {
  const { t } = useTranslation();
  const { hasRole } = useAuth();
  const { toast } = useToast();
  const mutation = useLockedFirstStop();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isLocked = lockedFirstStopId === stopId;
  const canWrite = hasRole("admin", "dispatcher")
    && EDITABLE_ROUTE_STATUSES.has(routeStatus ?? "")
    && stopStatus === "pending"
    && stopRouteId === routeId;
  const disabled = mutation.isPending || !canWrite;

  const save = () => {
    setConfirmOpen(false);
    mutation.mutate({
      routeId,
      stopId: isLocked ? null : stopId,
      planRevision,
    }, {
      onSuccess: (savedRoute) => {
        toast({
          title: isLocked
            ? t("routeLock.removed")
            : t("routeLock.saved"),
        });
        void onSaved?.(savedRoute);
      },
      onError: (error) => {
        toast({
          title: t("common.error"),
          description: localizeError(error, t, {
            fallbackKey: "routeLock.saveError",
          }),
          variant: "destructive",
        });
      },
    });
  };

  const requestSave = () => {
    if (disabled) return;
    if (hasUnsavedLocalChanges) {
      setConfirmOpen(true);
      return;
    }
    save();
  };

  const label = isLocked
    ? t("routeLock.remove")
    : t("routeLock.lock");
  const disabledReason = !hasRole("admin", "dispatcher")
    ? t("routeLock.readOnly")
    : routeStatus && !EDITABLE_ROUTE_STATUSES.has(routeStatus)
      ? t("routeLock.executionDisabled")
      : stopStatus !== "pending"
        ? t("routeLock.pendingOnly")
        : t("routeLock.assignedOnly");

  return (
    <>
      <div className={cn("inline-flex items-center gap-1", className)}>
        {isLocked && (
          <span
            className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-1 text-[10px] font-semibold text-primary"
            data-testid={`status-locked-first-stop-${stopId}`}
            title={t("routeLock.locked")}
          >
            <LockKeyhole className="h-3 w-3" aria-hidden="true" />
            {!compact && t("routeLock.locked")}
          </span>
        )}
        <Button
          type="button"
          variant={isLocked ? "secondary" : "ghost"}
          size={compact ? "icon" : "sm"}
          className={cn(
            compact ? "h-8 w-8" : "h-8 gap-1 px-2 text-xs",
            isLocked && "text-primary",
          )}
          onClick={requestSave}
          disabled={disabled}
          data-testid={`${isLocked ? "button-remove" : "button-lock"}-first-stop-${stopId}`}
          aria-label={label}
          title={disabled ? disabledReason : label}
        >
          {isLocked ? (
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {!compact && label}
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("routeLock.unsavedTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("routeLock.unsavedDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-first-stop-lock">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                save();
              }}
              data-testid="button-confirm-first-stop-lock"
            >
              {t("routeLock.continue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}