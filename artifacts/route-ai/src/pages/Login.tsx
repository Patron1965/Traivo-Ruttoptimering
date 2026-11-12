import { useEffect, useState, type FormEvent } from "react";
import { Truck, Loader2, AlertCircle, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { getErrorStatus, localizeError } from "@/lib/localize-error";
import { OperatorMfaRecovery } from "@/components/platform/OperatorMfaRecovery";

export default function Login() {
  const { login, finishMfa } = useAuth();
  const [location, navigate] = useLocation();
  const providerLogin = location.startsWith("/platform");
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState("");
  const [resendWait, setResendWait] = useState(0);
  const [notice, setNotice] = useState("");
  const [operatorRecovery, setOperatorRecovery] = useState(false);

  useEffect(() => {
    if (!providerLogin) return;
    fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/auth/mfa/status`, { credentials: "include" })
      .then(async (res) => { if (res.ok) setMfa(true); })
      .catch(() => {});
  }, [providerLogin]);
  useEffect(() => {
    if (!mfa) return;
    const timer = setInterval(() => setResendWait(value => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [mfa]);

  const currentLang = i18n.language;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const mfaRequired = await login(email.trim(), password);
      if (mfaRequired) {
        setMfa(true);
        setPassword("");
        setResendWait(60);
        setNotice("En inloggningskod har skickats till din registrerade e-postadress. Kontrollera även skräpposten.");
        return;
      }
      if (providerLogin) {
        navigate("/platform");
        return;
      }
      if (location === "/login") {
        navigate("/");
      }
    } catch (err) {
      // A rejected login is not an expired session. Keep unknown, disabled and
      // wrong-password accounts indistinguishable.
      setError(getErrorStatus(err) === 401
        ? t("auth.invalidCredentials")
        : localizeError(err, t, { fallbackKey: "auth.signInFailed" }));
    } finally {
      setSubmitting(false);
    }
  }

  async function mfaRequest(path: string, body?: object) {
    const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/auth/mfa/${path}`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(data.error || "Koden kunde inte verifieras");
    return data;
  }

  async function handleMfa(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const data = await mfaRequest("verify", { code: code.trim() });
      finishMfa(data.user, data.session);
      setCode("");
      navigate("/platform");
    } catch (err) { setError(err instanceof Error ? err.message : "Ogiltig kod"); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm flex justify-end mb-4">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {(["sv", "en"] as const).map((lng) => (
            <button
              key={lng}
              onClick={() => i18n.changeLanguage(lng)}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-bold transition-all",
                currentLang === lng
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {lng.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-14 w-14 rounded-2xl bg-primary flex items-center justify-center mb-4">
            <Truck className="h-7 w-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{providerLogin ? "Traivo Admin" : t("auth.appName")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{providerLogin ? "Endast för Traivos leverantörsadministratörer" : "Logga in till din organisations arbetsmiljö"}</p>
        </div>

        {operatorRecovery ? <OperatorMfaRecovery initialEmail={email}
          onCancel={() => { setOperatorRecovery(false); setMfa(false); setError(null); }}
          onRecovered={() => {
            setOperatorRecovery(false); setMfa(true); setResendWait(60);
            setPassword(""); setCode(""); setError(null);
            setNotice("En inloggningskod har skickats till din registrerade e-postadress.");
          }} /> : <form onSubmit={mfa ? handleMfa : handleSubmit} className="space-y-4 bg-card border border-border rounded-2xl p-6 shadow-sm">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 text-destructive text-sm p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {mfa ? (
            <>
              <h2 className="font-semibold">Bekräfta med kod från mejlet</h2>
              <p className="text-sm text-muted-foreground" role="status">{notice || "Ange koden från Traivo-mejlet eller begär en ny kod."}</p>
              <p className="text-xs text-muted-foreground">Koden gäller i högst fem minuter. Ingen autentiseringsapp behövs.</p>
              <label htmlFor="mfa-code" className="block text-sm">Sexsiffrig kod från mejlet</label>
              <input id="mfa-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                required className="w-full rounded-lg border border-input bg-background px-3 py-2" />
              <button type="submit" disabled={submitting} className="w-full rounded-lg bg-primary p-2 text-primary-foreground">Verifiera</button>
              <button type="button" disabled={submitting || resendWait > 0} className="block text-sm text-primary underline disabled:opacity-50"
                onClick={async () => {
                  setSubmitting(true); setError(null); setNotice("");
                  try { await mfaRequest("resend"); setCode(""); setResendWait(60); setNotice("En ny kod har skickats. Använd den senaste koden."); }
                  catch (err) { setError(err instanceof Error ? err.message : "Koden kunde inte skickas."); }
                  finally { setSubmitting(false); }
                }}>{resendWait > 0 ? `Skicka ny kod om ${resendWait} s` : "Skicka ny kod"}</button>
              <button type="button" onClick={() => { setMfa(false); setCode(""); setNotice(""); setError(null); }} className="text-sm text-primary underline">Tillbaka till inloggning</button>
            </>
          ) : <>
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium text-foreground">{t("auth.email")}</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={t("auth.emailPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-foreground">{t("auth.password")}</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="••••••••"
            />
          </div>

          <div className="text-right">
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => navigate("/forgot-password")}
            >
              {t("auth.forgotLink")}
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? t("auth.signingIn") : t("auth.signIn")}
          </button>
          </>}
        </form>}
        {!operatorRecovery && (providerLogin || mfa) && (
          <button type="button" disabled={submitting} className="mt-4 text-sm text-primary underline"
            onClick={() => {
              setOperatorRecovery(true); setPassword(""); setCode(""); setError(null);
            }}>
            Återställ säkerhetsinloggningen med operatörens hjälp
          </button>
        )}
      </div>
    </div>
  );
}
