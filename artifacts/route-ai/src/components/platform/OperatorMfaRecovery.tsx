import { useState, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

interface OperatorMfaRecoveryProps {
  initialEmail: string;
  onRecovered: () => void;
  onCancel: () => void;
}

/** Approval credentials stay in this form's memory, never URLs or browser storage. */
export function OperatorMfaRecovery({ initialEmail, onRecovered, onCancel }: OperatorMfaRecoveryProps) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [recoveryToken, setRecoveryToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/auth/mfa/operator-recovery`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, recoveryToken: recoveryToken.trim() }),
      });
      if (!response.ok) {
        setError(response.status === 429
          ? "För många försök. Vänta en stund innan du försöker igen."
          : response.status === 503
            ? "Operatörsåterställning är inte tillgänglig. Kontrollera driftmiljöns återställningspolicy."
            : "Återställningen kunde inte godkännas. Kontrollera inloggningsuppgifterna och att operatörens engångsbehörighet fortfarande gäller.");
        return;
      }
      const result = await response.json();
      if (result.mfaRequired !== true || result.enrollmentRequired !== true) {
        throw new Error("Unexpected recovery response");
      }
      setPassword("");
      setRecoveryToken("");
      onRecovered();
    } catch {
      setError("Återställningen kunde inte slutföras. Om engångsbehörigheten redan förbrukats behöver operatören utfärda en ny.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-card border border-border rounded-2xl p-6 shadow-sm">
      <h2 className="font-semibold">Operatörsgodkänd MFA-återställning</h2>
      <p className="text-sm text-muted-foreground">
        För dig vars säkerhetsinloggning har spärrats och behöver återställas av en behörig operatör.
        En behörig operatör måste först utfärda en tidsbegränsad engångsbehörighet i driftmiljön.
        E-poståtkomst eller kundadmin räcker inte.
      </p>
      {error && <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 text-destructive text-sm p-3">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /><span>{error}</span>
      </div>}
      <div className="space-y-1.5">
        <label htmlFor="operator-recovery-email" className="block text-sm font-medium">Superuser-kontots e-postadress</label>
        <input id="operator-recovery-email" type="email" autoComplete="username" required disabled={submitting}
          value={email} onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="operator-recovery-password" className="block text-sm font-medium">Lösenord</label>
        <input id="operator-recovery-password" type="password" autoComplete="current-password" required disabled={submitting}
          value={password} onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="operator-recovery-token" className="block text-sm font-medium">Operatörens engångsbehörighet</label>
        <input id="operator-recovery-token" type="password" autoComplete="off" spellCheck={false} required disabled={submitting}
          value={recoveryToken} onChange={(event) => setRecoveryToken(event.target.value)}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
        <p className="text-xs text-muted-foreground">Använd värdet från operatörens säkra fil, inte en gammal MFA-återställningskod. Dela det inte i chatt eller e-post.</p>
      </div>
      <p className="text-sm text-muted-foreground">
        Godkännandet återställer säkerhetsinloggningen. Du får tillgång till administrationen först när koden som skickas till din registrerade e-postadress har verifierats.
      </p>
      <button type="submit" disabled={submitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary p-2 text-primary-foreground disabled:opacity-60">
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {submitting ? "Kontrollerar…" : "Fortsätt till ny MFA"}
      </button>
      <button type="button" disabled={submitting} onClick={onCancel} className="text-sm text-primary underline">
        Tillbaka till inloggning
      </button>
    </form>
  );
}