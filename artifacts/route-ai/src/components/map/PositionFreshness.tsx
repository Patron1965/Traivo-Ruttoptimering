import { useEffect, useState } from "react";
import { positionFreshness } from "@/lib/position-freshness";

export function PositionFreshness({ measuredAt }: { measuredAt?: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const freshness = positionFreshness(measuredAt, now);
  return (
    <div className="border-t border-border pt-2 text-xs" data-testid="gps-freshness" data-status={freshness.status}>
      <p className={freshness.status === "current" ? "text-foreground" : "font-semibold text-amber-700 dark:text-amber-400"}>
        {freshness.status === "missing" ? "GPS-rapport saknas – positionen är inte verifierad live"
          : freshness.status === "stale" ? "GPS-positionen är inaktuell (äldre än 2 min)" : "Aktuell GPS-rapport"}
      </p>
      {freshness.status !== "missing" && measuredAt && (
        <p className="mt-1 text-muted-foreground">
          Senast rapporterad: {new Date(measuredAt).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })}
        </p>
      )}
    </div>
  );
}
