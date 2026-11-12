import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
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

interface DispatchReauthenticationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

/**
 * Re-authenticates only the current user in place. It deliberately does not
 * accept or retain the failed dispatch move, so closing the dialog never
 * replays a write against the dispatch timeline.
 */
export function DispatchReauthenticationDialog({
  open,
  onOpenChange,
  onSuccess,
}: DispatchReauthenticationDialogProps) {
  const { user, login } = useAuth();
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setError(null);
  }, [open]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user?.email || submitting) return;

    setError(null);
    setSubmitting(true);
    try {
      await login(user.email, password);
      setPassword("");
      onOpenChange(false);
      onSuccess();
    } catch (loginError) {
      setError(
        loginError instanceof Error && loginError.message.trim()
          ? loginError.message
          : t("dispatch.reauthenticationFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Keep the form mounted until an in-flight login has settled.
        if (!nextOpen && submitting) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent data-testid="dispatch-reauth-dialog">
        <DialogHeader>
          <DialogTitle>{t("dispatch.reauthenticationTitle")}</DialogTitle>
          <DialogDescription>
            {t("dispatch.reauthenticationDescription")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="dispatch-reauth-email">{t("auth.email")}</Label>
            <Input
              id="dispatch-reauth-email"
              type="email"
              value={user?.email ?? ""}
              readOnly
              autoComplete="username"
              aria-readonly="true"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dispatch-reauth-password">{t("auth.password")}</Label>
            <Input
              id="dispatch-reauth-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              autoFocus
              placeholder={t("dispatch.reauthenticationPasswordPlaceholder")}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !user?.email}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting
                ? t("dispatch.reauthenticationSigningIn")
                : t("dispatch.reauthenticationSignIn")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}