import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail, Phone, Route as RouteIcon, Send, Truck, UserRound, Loader2, ShieldOff } from "lucide-react";
import type { Driver } from "@workspace/api-client-react";
import type { ScheduledRow } from "@/lib/scheduling";
import { useUpdateDriver } from "@/hooks/use-drivers";
import { useAuth } from "@/lib/auth-context";
import { localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

type ResendStatus = "idle" | "pending" | "sent" | "not_configured" | "missing_phone" | "failed" | "error";

interface DriverDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driver: Driver | null;
  row: ScheduledRow | null;
}

const SMS_STATUSES: ResendStatus[] = ["sent", "not_configured", "missing_phone", "failed"];

function isValidPhone(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || /^\+?[0-9][0-9 ()-]{6,}$/.test(trimmed);
}

export function DriverDetailsDialog({
  open,
  onOpenChange,
  driver,
  row,
}: DriverDetailsDialogProps) {
  const { t } = useTranslation();
  const { hasRole, user } = useAuth();
  const updateDriver = useUpdateDriver();
  const [phoneDraft, setPhoneDraft] = useState(driver?.phone ?? "");
  const [savedPhone, setSavedPhone] = useState(driver?.phone ?? "");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<ResendStatus>("idle");
  const [resendError, setResendError] = useState<string | null>(null);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [revokeStatus, setRevokeStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);
  const wasOpenRef = useRef(false);
  const previousDriverIdRef = useRef<string | null>(driver?.id ?? null);
  const previousRouteIdRef = useRef<string | null>(row?.routeId ?? null);
  const activeDriverIdRef = useRef<string | null>(open ? driver?.id ?? null : null);
  const activeRouteIdRef = useRef<string | null>(open ? row?.routeId ?? null : null);

  const canEdit = hasRole("admin", "dispatcher");
  const phoneIsValid = isValidPhone(phoneDraft);
  const phoneIsDirty = phoneDraft !== savedPhone;
  const normalizedSavedPhone = savedPhone.trim();
  const phoneError = phoneIsValid ? null : t("dispatch.driverPhoneInvalid");

  // Reset when a dialog is opened or switched to another driver. For a
  // same-driver query refresh, only update the draft when it is still clean.
  // This prevents a dirty edit for driver A from appearing for driver B while
  // keeping contact data fresh after useUpdateDriver invalidates the query.
  useEffect(() => {
    const openedNow = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    activeDriverIdRef.current = open ? driver?.id ?? null : null;
    activeRouteIdRef.current = open ? row?.routeId ?? null : null;

    if (!open) return;
    if (!driver) {
      previousDriverIdRef.current = null;
      return;
    }

    const switchedDriver = previousDriverIdRef.current !== driver.id;
    const switchedRoute = previousRouteIdRef.current !== (row?.routeId ?? null);
    previousDriverIdRef.current = driver.id;
    previousRouteIdRef.current = row?.routeId ?? null;
    if (openedNow || switchedDriver) {
      const nextPhone = driver.phone ?? "";
      setPhoneDraft(nextPhone);
      setSavedPhone(nextPhone);
      setSaveStatus("idle");
      setSaveError(null);
      setResendStatus("idle");
      setResendError(null);
      setRevokeStatus("idle");
      setRevokeMessage(null);
      setRevokeConfirmOpen(false);
      return;
    }
    if (switchedRoute) {
      setSaveStatus("idle");
      setSaveError(null);
      setResendStatus("idle");
      setResendError(null);
    }

    setSavedPhone((currentSavedPhone) => {
      setPhoneDraft((currentDraft) =>
        currentDraft === currentSavedPhone ? (driver.phone ?? "") : currentDraft,
      );
      return driver.phone ?? "";
    });
  }, [open, driver?.id, driver?.phone, row?.routeId]);

  const dispatchReason = useMemo(() => {
    if (!driver || !row) return t("dispatch.driverUnavailable");
    if (row.routeId === "unplanned") return t("dispatch.driverSmsNotDispatched");
    if (row.driverId !== driver.id) return t("dispatch.driverAssignmentChanged");
    if (!row.handoffDriverId || !row.sentAt || !row.handoffStatus || row.handoffStatus === "pending") {
      return t("dispatch.driverSmsNotDispatched");
    }
    if (row.handoffDriverId !== driver.id) {
      return t("dispatch.driverSmsSentToAnotherDriver");
    }
    if (
      row.planRevision == null ||
      row.handoffVersion == null ||
      row.handoffVersion !== row.planRevision
    ) {
      return t("dispatch.driverSmsStaleVersion");
    }
    if (!normalizedSavedPhone) return t("dispatch.driverSmsMissingPhone");
    if (!canEdit) return t("dispatch.driverSmsViewerReadonly");
    if (phoneIsDirty || !phoneIsValid || updateDriver.isPending || resendStatus === "pending") {
      return t("dispatch.driverSmsSavePhoneFirst");
    }
    return t("dispatch.driverSmsReady");
  }, [
    canEdit,
    driver,
    normalizedSavedPhone,
    phoneIsDirty,
    phoneIsValid,
    row,
    resendStatus,
    t,
    updateDriver.isPending,
  ]);

  const resendAllowed = Boolean(
    driver &&
      row &&
      row.routeId !== "unplanned" &&
      row.driverId === driver.id &&
      row.handoffDriverId === driver.id &&
      row.sentAt &&
      row.handoffStatus &&
      row.handoffStatus !== "pending" &&
      row.planRevision != null &&
      row.handoffVersion != null &&
      row.handoffVersion === row.planRevision &&
      normalizedSavedPhone &&
      canEdit &&
      !phoneIsDirty &&
      phoneIsValid &&
      !updateDriver.isPending &&
      resendStatus !== "pending",
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (updateDriver.isPending || resendStatus === "pending")) return;
    if (!nextOpen && phoneIsDirty) {
      const confirmed = typeof window === "undefined"
        ? true
        : window.confirm(t("dispatch.driverUnsavedChangesConfirm"));
      if (!confirmed) return;
    }
    onOpenChange(nextOpen);
  };

  const savePhone = () => {
    if (
      !driver ||
      !user?.organizationId ||
      !canEdit ||
      !phoneIsDirty ||
      !phoneIsValid ||
      updateDriver.isPending ||
      resendStatus === "pending"
    ) return;
    const requestDriverId = driver.id;
    const requestRouteId = row?.routeId ?? null;
    const requestPhone = phoneDraft.trim();
    setSaveStatus("idle");
    setSaveError(null);
    updateDriver.mutate(
      {
        id: requestDriverId,
        data: { phone: requestPhone || null },
        params: { organizationId: user.organizationId },
      },
      {
        onSuccess: () => {
          if (
            activeDriverIdRef.current !== requestDriverId ||
            activeRouteIdRef.current !== requestRouteId
          ) return;
          setSavedPhone(requestPhone);
          setPhoneDraft(requestPhone);
          setSaveStatus("saved");
          setResendStatus("idle");
          setResendError(null);
        },
        onError: (error) => {
          if (
            activeDriverIdRef.current !== requestDriverId ||
            activeRouteIdRef.current !== requestRouteId
          ) return;
          setSaveStatus("error");
          setSaveError(localizeError(error, t, { fallbackKey: "dispatch.driverSaveError" }));
        },
      },
    );
  };

  const resendSms = async () => {
    if (!driver || !row || !resendAllowed) return;
    const requestDriverId = driver.id;
    const requestRouteId = row.routeId;
    const isCurrentDialog = () =>
      activeDriverIdRef.current === requestDriverId &&
      activeRouteIdRef.current === requestRouteId;
    setResendStatus("pending");
    setResendError(null);
    try {
      const apiBase = (
        import.meta.env.VITE_API_URL ||
        import.meta.env.BASE_URL.replace(/\/$/, "")
      ).replace(/\/$/, "");
      const response = await fetch(`${apiBase}/api/routes/${row.routeId}/resend-sms`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverId: requestDriverId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(
          typeof body?.error === "string" ? body.error : t("dispatch.driverSmsFailed"),
        );
        Object.assign(error, { status: response.status, data: body });
        throw error;
      }
      const status = body?.status;
      if (!SMS_STATUSES.includes(status)) {
        throw new TrustedLocalizedError(t("dispatch.driverSmsUnknownStatus"));
      }
      if (!isCurrentDialog()) return;
      setResendStatus(status);
    } catch (error) {
      if (!isCurrentDialog()) return;
      setResendStatus("error");
      setResendError(localizeError(error, t, { fallbackKey: "dispatch.driverSmsFailed" }));
    }
  };

  const revokeAccess = async () => {
    if (!driver || !canEdit || revokeStatus === "pending") return;
    const requestDriverId = driver.id;
    const isCurrentDriver = () => activeDriverIdRef.current === requestDriverId;
    setRevokeConfirmOpen(false);
    setRevokeStatus("pending");
    setRevokeMessage(null);
    try {
      const apiBase = (
        import.meta.env.VITE_API_URL ||
        import.meta.env.BASE_URL.replace(/\/$/, "")
      ).replace(/\/$/, "");
      const response = await fetch(`${apiBase}/api/drivers/${encodeURIComponent(requestDriverId)}/revoke-access`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(typeof body?.error === "string" ? body.error : "revoke failed");
        Object.assign(error, { status: response.status, data: body });
        throw error;
      }
      if (typeof body?.revoked !== "number") {
        throw new TrustedLocalizedError(t("dispatch.driverRevokeFailed", { defaultValue: "Mobilåtkomsten kunde inte återkallas. Försök igen." }));
      }
      if (!isCurrentDriver()) return;
      setRevokeStatus("done");
      setRevokeMessage(body.revoked > 0
        ? t("dispatch.driverRevokeDone", { count: body.revoked, defaultValue: "Mobilåtkomsten är återkallad ({{count}} st). Skicka ett nytt SMS när chauffören ska in igen." })
        : t("dispatch.driverRevokeNone", { defaultValue: "Det fanns ingen aktiv mobilåtkomst att återkalla." }));
    } catch (error) {
      if (!isCurrentDriver()) return;
      setRevokeStatus("error");
      setRevokeMessage(localizeError(error, t, { fallbackKey: "dispatch.driverRevokeFailed" }));
    }
  };

  const resendStatusMessage = resendStatus === "sent"
    ? t("dispatch.driverSmsSent")
    : resendStatus === "not_configured"
      ? t("dispatch.driverSmsNotConfigured")
      : resendStatus === "missing_phone"
        ? t("dispatch.driverSmsMissingPhone")
        : resendStatus === "failed"
          ? t("dispatch.driverSmsFailed")
          : resendStatus === "error"
            ? resendError
            : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="h-5 w-5 text-primary" />
            {driver?.name ?? t("dispatch.driverUnavailable")}
          </DialogTitle>
          <DialogDescription>
            {t("dispatch.driverDetailsDescription")}
          </DialogDescription>
        </DialogHeader>

        {driver && row ? (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm sm:grid-cols-2">
              <div className="flex min-w-0 items-center gap-2">
                <RouteIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate" title={row.routeName}>{row.routeName}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Truck className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate" title={row.vehicleName}>{row.vehicleName}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{driver.phone || t("dispatch.driverNoPhone")}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{driver.email || t("dispatch.driverNoEmail")}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="gantt-driver-phone">{t("dispatch.driverPhone")}</Label>
              <Input
                id="gantt-driver-phone"
                value={phoneDraft}
                onChange={(event) => {
                  setPhoneDraft(event.target.value);
                  setSaveStatus("idle");
                  setSaveError(null);
                  setResendStatus("idle");
                  setResendError(null);
                }}
                readOnly={!canEdit}
                disabled={updateDriver.isPending || resendStatus === "pending"}
                aria-readonly={!canEdit}
                type="tel"
                aria-invalid={Boolean(phoneError)}
                placeholder="+46 70 123 4567"
              />
              {phoneError && <p className="text-xs text-destructive">{phoneError}</p>}
              {!canEdit && (
                <p className="text-xs text-muted-foreground">{t("dispatch.driverPhoneViewerReadonly")}</p>
              )}
              {saveError && <p className="text-xs text-destructive" role="alert">{saveError}</p>}
              {saveStatus === "saved" && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
                  {t("dispatch.driverPhoneSaved")}
                </p>
              )}
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{t("dispatch.driverSmsTitle")}</p>
                  <p className="text-xs text-muted-foreground">{dispatchReason}</p>
                </div>
                <Send className="h-4 w-4 shrink-0 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">{t("dispatch.driverSmsAcceptanceNote")}</p>
              {resendStatusMessage && (
                <p
                  className={cn(
                    "text-xs",
                    resendStatus === "sent"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : resendStatus === "error" || resendStatus === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                  role={resendStatus === "error" || resendStatus === "failed" ? "alert" : "status"}
                >
                  {resendStatusMessage}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("dispatch.driverUnavailable")}</p>
        )}

        {driver && canEdit && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-dashed p-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold">{t("dispatch.driverRevokeTitle", { defaultValue: "Mobilåtkomst" })}</p>
              <p className="text-xs text-muted-foreground">
                {t("dispatch.driverRevokeHint", { defaultValue: "Loggar ut chaufförens telefon och gör tidigare länkar ogiltiga." })}
              </p>
              {revokeMessage && (
                <p
                  className={cn("text-xs", revokeStatus === "error" ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}
                  role={revokeStatus === "error" ? "alert" : "status"}
                >
                  {revokeMessage}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 text-destructive hover:text-destructive"
              onClick={() => setRevokeConfirmOpen(true)}
              disabled={revokeStatus === "pending"}
              data-testid="button-revoke-driver-access"
            >
              {revokeStatus === "pending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
              {t("dispatch.driverRevokeButton", { defaultValue: "Återkalla mobilåtkomst" })}
            </Button>
          </div>
        )}

        <AlertDialog open={revokeConfirmOpen} onOpenChange={setRevokeConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("dispatch.driverRevokeConfirmTitle", { name: driver?.name ?? "", defaultValue: "Återkalla mobilåtkomst för {{name}}?" })}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>{t("dispatch.driverRevokeConfirmPhone", { defaultValue: "Chaufförens telefon loggas ut och alla tidigare skickade länkar slutar fungera direkt." })}</p>
                  <p>{t("dispatch.driverRevokeConfirmRoute", { defaultValue: "Rutten och tilldelningen ändras inte. Inget meddelande skickas till chauffören." })}</p>
                  <p>{t("dispatch.driverRevokeConfirmSms", { defaultValue: "För att chauffören ska komma in igen måste du skicka ett nytt SMS." })}</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel", { defaultValue: "Avbryt" })}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { void revokeAccess(); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-revoke-driver-access"
              >
                {t("dispatch.driverRevokeButton", { defaultValue: "Återkalla mobilåtkomst" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={savePhone}
            disabled={
              !driver ||
              !canEdit ||
              !phoneIsDirty ||
              !phoneIsValid ||
              updateDriver.isPending ||
              resendStatus === "pending"
            }
          >
            {updateDriver.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {updateDriver.isPending ? t("common.saving") : t("common.save")}
          </Button>
          <Button
            type="button"
            onClick={resendSms}
            disabled={!resendAllowed}
          >
            {resendStatus === "pending" && <Loader2 className="h-4 w-4 animate-spin" />}
            {resendStatus === "pending" ? t("dispatch.driverSmsSending") : t("dispatch.resendRouteSms")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}