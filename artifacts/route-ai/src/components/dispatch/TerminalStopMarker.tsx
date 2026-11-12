import * as React from "react";

export function TerminalStopMarker({ stop }: {
  stop: { status?: string | null; terminalAt?: string | null };
}) {
  const skipped = stop.status === "skipped";
  if (!skipped && stop.status !== "completed") return null;
  const date = stop.terminalAt ? new Date(stop.terminalAt) : null;
  const status = skipped ? "Hoppat över av chauffören" : "Genomfört";
  const label = date && Number.isFinite(date.getTime())
    ? `${status} ${date.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" })} · faktisk tid`
    : `${status} · faktisk tid saknas`;
  return (
    <span role="img" title={label} aria-label={label}
      data-testid={skipped ? "stop-skipped-marker" : "stop-completion-marker"}
      className={skipped ? "sr-only" : "absolute -top-2 -right-1 z-20 rounded-full text-white text-[9px] leading-3 px-0.5 bg-emerald-700"}>
      {skipped ? label : "✓"}
    </span>
  );
}
