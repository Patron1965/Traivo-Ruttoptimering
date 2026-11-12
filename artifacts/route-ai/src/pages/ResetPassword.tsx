import { useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2, LockKeyhole, Truck, AlertCircle } from "lucide-react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { localizeError } from "@/lib/localize-error";

const API_BASE = import.meta.env.VITE_API_URL || "";

export default function ResetPassword() {
  const [, navigate] = useLocation();
  const { t } = useTranslation();
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") || "", []);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(token ? null : t("auth.resetMissing"));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!token) {
      setError(t("auth.resetMissing"));
      return;
    }
    if (password.length < 8) {
      setError(t("auth.resetTooShort"));
      return;
    }
    if (password !== confirmation) {
      setError(t("auth.resetMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const resetError = new Error(body.message || t("auth.resetExpired"));
        Object.assign(resetError, { status: response.status, data: body });
        throw resetError;
      }
      setMessage(t("auth.resetSuccess"));
    } catch (reason) {
      setError(localizeError(reason, t, { fallbackKey: "auth.resetError" }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-14 w-14 rounded-2xl bg-primary flex items-center justify-center mb-4">
            <Truck className="h-7 w-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t("auth.resetTitle")}</h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">
            {t("auth.resetDescription")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 bg-card border border-border rounded-2xl p-6 shadow-sm">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 text-destructive text-sm p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {message && (
            <div role="status" className="flex items-start gap-2 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-sm p-3">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{message}</span>
            </div>
          )}
          {!message && (
            <>
              <PasswordField
                id="new-password"
                label={t("auth.newPassword")}
                value={password}
                visible={showPassword}
                onChange={setPassword}
                onToggle={() => setShowPassword((visible) => !visible)}
                visibleLabel={t("auth.hidePassword")}
                hiddenLabel={t("auth.showPassword")}
              />
              <PasswordField
                id="confirm-password"
                label={t("auth.confirmPassword")}
                value={confirmation}
                visible={showConfirmation}
                onChange={setConfirmation}
                onToggle={() => setShowConfirmation((visible) => !visible)}
                visibleLabel={t("auth.hidePassword")}
                hiddenLabel={t("auth.showPassword")}
              />
              <button
                type="submit"
                disabled={submitting || !token}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
                {t("auth.resetSubmit")}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="w-full inline-flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> {t("auth.resetBack")}
          </button>
        </form>
      </div>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  visible,
  onChange,
  onToggle,
  visibleLabel,
  hiddenLabel,
}: {
  id: string;
  label: string;
  value: string;
  visible: boolean;
  onChange: (value: string) => void;
  onToggle: () => void;
  visibleLabel: string;
  hiddenLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      <div className="relative">
        <LockKeyhole className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          required
          minLength={8}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-lg border border-input bg-background pl-9 pr-10 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={visible ? visibleLabel : hiddenLabel}
          className="absolute right-2 top-1.5 rounded p-1 text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}