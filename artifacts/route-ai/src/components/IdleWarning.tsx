import { useEffect, useRef, useState, useCallback } from "react";
import { Clock, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";

const WARNING_LEAD_MS = 2 * 60 * 1000;

export function IdleWarning() {
  const { t } = useTranslation();
  const { user, session, logout, refreshSession } = useAuth();
  const [warning, setWarning] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [extending, setExtending] = useState(false);

  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const idleMs = (session?.idleTimeoutMin ?? 15) * 60 * 1000;

  const clearTimers = useCallback(() => {
    if (warnTimer.current) clearTimeout(warnTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    warnTimer.current = null;
    countdownTimer.current = null;
  }, []);

  const startCountdown = useCallback(() => {
    setWarning(true);
    setCountdown(Math.round(WARNING_LEAD_MS / 1000));
    countdownTimer.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownTimer.current) clearInterval(countdownTimer.current);
          logout();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [logout]);

  const scheduleWarning = useCallback(() => {
    clearTimers();
    setWarning(false);
    const lead = Math.max(idleMs - WARNING_LEAD_MS, 1000);
    warnTimer.current = setTimeout(startCountdown, lead);
  }, [clearTimers, idleMs, startCountdown]);

  useEffect(() => {
    if (!user) {
      clearTimers();
      setWarning(false);
      return;
    }

    scheduleWarning();

    const onActivity = () => {
      if (warning) return;
      scheduleWarning();
    };

    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      clearTimers();
    };
  }, [user, warning, scheduleWarning, clearTimers]);

  async function handleExtend() {
    setExtending(true);
    const ok = await refreshSession();
    setExtending(false);
    if (ok) {
      scheduleWarning();
    } else {
      logout();
    }
  }

  if (!user || !warning) return null;

  const mins = Math.floor(countdown / 60);
  const secs = countdown % 60;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 rounded-2xl bg-card border border-border p-6 shadow-2xl text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-amber-500/15 flex items-center justify-center mb-4">
          <Clock className="h-6 w-6 text-amber-500" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">{t("auth.idleTitle")}</h2>
        <p className="text-sm text-muted-foreground mt-2">
          {t("auth.idleBody")}{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {mins}:{secs.toString().padStart(2, "0")}
          </span>
          .
        </p>
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => logout()}
            className="flex-1 rounded-lg border border-border py-2.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
          >
            {t("auth.logoutNow")}
          </button>
          <button
            onClick={handleExtend}
            disabled={extending}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {extending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("auth.stayLoggedIn")}
          </button>
        </div>
      </div>
    </div>
  );
}
