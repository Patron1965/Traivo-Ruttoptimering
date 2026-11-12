import { useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Loader2, Mail, Truck, AlertCircle } from "lucide-react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { localizeError } from "@/lib/localize-error";

const API_BASE = import.meta.env.VITE_API_URL || "";

export default function ForgotPassword() {
  const [, navigate] = useLocation();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 503) {
        const error = new Error(body.message || t("auth.forgotUnavailable"));
        Object.assign(error, { status: response.status, data: body });
        throw error;
      }
      if (!response.ok) {
        const error = new Error(body.message || t("auth.forgotError"));
        Object.assign(error, { status: response.status, data: body });
        throw error;
      }
      setMessage(t("auth.forgotSuccess"));
    } catch (reason) {
      setError(localizeError(reason, t, { fallbackKey: "auth.forgotError" }));
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
          <h1 className="text-2xl font-bold text-foreground">{t("auth.forgotTitle")}</h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">
            {t("auth.forgotDescription")}
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
          <div className="space-y-1.5">
            <label htmlFor="recovery-email" className="text-sm font-medium text-foreground">E-post</label>
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                id="recovery-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-lg border border-input bg-background pl-9 pr-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="namn@foretag.se"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : t("auth.forgotSubmit")}
          </button>
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="w-full inline-flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> {t("auth.forgotBack")}
          </button>
        </form>
      </div>
    </div>
  );
}