import { useState } from "react";
import { FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadDistrictExport, type DistrictJob, type DistrictZone } from "@/lib/district-api";
import { useDistrictExports } from "@/hooks/use-districts";
import { ErrorLine } from "./DistrictImport";
import { isJobStale } from "./ResultPanel";

export function ExportHistory({ planId, zones, jobs, canDownload }: { planId: string; canDownload: boolean; zones: readonly DistrictZone[]; jobs: readonly DistrictJob[] }) {
  const { data, isLoading, error, refetch } = useDistrictExports(planId);
  const [dlError, setDlError] = useState<unknown>(null);
  const zoneName = new Map(zones.map((z) => [z.id, z]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  if (isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />)}</div>;
  if (error) return <ErrorLine error={error} onRetry={() => void refetch()} />;
  const list = [...(data?.exports ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (list.length === 0) return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Inga uttag ännu. Uttag skapas från en klar optimering.</p>;

  const get = (id: string, f: "csv" | "xlsx") => { setDlError(null); downloadDistrictExport(planId, id, f).catch(setDlError); };
  return (
    <div className="space-y-2" data-testid="panel-export-history">
      <p className="text-[11px] text-muted-foreground">Filerna återskapas från oföränderliga snapshots. Exporterat betyder inte utfört eller mottaget.</p>
      {!canDownload && <p className="rounded-md border bg-muted/50 p-2 text-xs" data-testid="text-download-restricted">Läsroller kan se uttagshistoriken men inte hämta filer, eftersom de innehåller originalkolumner med personuppgifter. Be en planerare eller administratör om filen.</p>}
      {dlError != null && <ErrorLine error={dlError} />}
      <ul className="space-y-1.5">{list.map((e) => {
        const job = jobById.get(e.jobId);
        const zone = e.zoneId ? zoneName.get(e.zoneId) : job ? zoneName.get(job.zoneId) : undefined;
        const latest = jobs.filter((j) => job && j.zoneId === job.zoneId).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
        const outdated = job ? isJobStale(job, zone, latest?.id !== job.id) : true;
        return (
          <li key={e.id} className="rounded-md border bg-card px-3 py-2 text-xs" data-testid={`row-export-${e.id}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{zone?.name ?? "Borttagen zon"} · {(e.pointCount ?? e.pointIds?.length ?? 0).toLocaleString("sv-SE")} stopp</span>
              {canDownload && <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => get(e.id, "csv")} data-testid={`button-download-csv-${e.id}`}><FileDown className="mr-1 h-3 w-3" />CSV</Button>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => get(e.id, "xlsx")} data-testid={`button-download-xlsx-${e.id}`}><FileDown className="mr-1 h-3 w-3" />XLSX</Button>
              </div>}
            </div>
            <div className="text-muted-foreground">
              {new Date(e.createdAt).toLocaleString("sv-SE")} · {e.actorName ?? e.createdBy ?? (e.actorId ? `användare ${e.actorId.slice(0, 8)}` : "okänd")}
              {e.fromSequence != null && e.toSequence != null && ` · nr ${e.fromSequence}–${e.toSequence}`}
              {outdated && <span className="ml-1 rounded bg-muted px-1">från äldre optimering</span>}
            </div>
          </li>
        );
      })}</ul>
    </div>
  );
}
