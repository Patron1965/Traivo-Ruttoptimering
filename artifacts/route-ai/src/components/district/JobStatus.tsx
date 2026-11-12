import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { DistrictJob } from "@/lib/district-api";
import { Progress } from "@/components/ui/progress";

export function JobStatus({ job }: { job: DistrictJob }) {
  const [now, setNow] = useState(Date.now);
  const active = job.status === "queued" || job.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, job.id]);
  // District worker progress is always 0–100, not a fractional value.
  const progress = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  const created = job.createdAt ? Date.parse(job.createdAt) : NaN;
  const elapsed = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 1000)) : null;
  const title = job.status === "queued" ? "Optimeringen väntar i kö"
    : job.status === "running" ? "Vägoptimering pågår"
    : job.status === "completed" ? "Optimeringen är klar"
    : job.status === "failed" ? "Optimeringen misslyckades"
    : job.status === "cancelled" ? "Optimeringen avbröts" : "Resultatet är inaktuellt";

  return (
    <div className="space-y-2" role="status" data-testid="district-optimization-status">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {active ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          : job.status === "completed" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
          : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
        <span>{title}</span>
      </div>
      {active && <>
        {progress > 0 ? <Progress value={progress} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Serverns framdrift" /> : (
          <div className="h-2 overflow-hidden rounded-full bg-primary/20" aria-label="Väntar på serverns framdrift">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {progress > 0 ? `${progress} % · ` : "Väntar på framdrift från servern · "}
          {elapsed !== null && `${Math.floor(elapsed / 60)} min ${elapsed % 60} s sedan start`}
        </p>
        <p className="text-xs text-muted-foreground">
          {job.status === "queued" ? "Jobbet är mottaget. Beräkningen börjar när en plats är ledig."
            : "Beräknar med vägdata. Stora zoner kan ta flera minuter. Körvägen visas på kartan när hela resultatet är klart."}
        </p>
      </>}
      {job.status === "completed" && <p className="text-xs text-muted-foreground">Körvägen och besöksordningen visas på kartan. Resultat och uttag finns i panelen.</p>}
      {job.error && <p className="text-xs text-destructive" data-testid="text-job-error">{job.error}</p>}
    </div>
  );
}