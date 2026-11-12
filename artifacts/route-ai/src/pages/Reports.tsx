import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Search, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.VITE_API_URL || "";

type ReportStop = {
  id: string;
  address: string;
  contactName: string | null;
  contactEmail: string | null;
  status: string;
  trackingCode: string | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  createdAt: string;
  routeName: string | null;
  routeDate: string | null;
};

type ReportResponse = {
  items: ReportStop[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export default function Reports() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const params = new URLSearchParams({ organizationId: organizationId!, page: String(page), pageSize: "25" });
  if (search) params.set("search", search);
  if (status !== "all") params.set("status", status);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);

  const { data, isLoading } = useQuery<ReportResponse>({
    queryKey: ["/api/reports/dispatched", organizationId, page, search, status, dateFrom, dateTo],
    queryFn: () => fetch(`${API_BASE}/api/reports/dispatched?${params}`).then(r => r.json()),
    enabled: !!organizationId,
  });

  const statusColors: Record<string, string> = {
    completed: "bg-emerald-500/10 text-emerald-500",
    failed: "bg-red-500/10 text-red-500",
    skipped: "bg-amber-500/10 text-amber-500",
    in_progress: "bg-blue-500/10 text-blue-500",
    pending: "bg-muted text-muted-foreground",
  };

  const exportCsv = () => {
    if (!data?.items?.length) return;
    const headers = ["ID", "Address", "Contact", "Status", "Route", "Date", "Tracking"];
    const rows = data.items.map(s => [s.id, s.address, s.contactName || "", s.status, s.routeName || "", s.routeDate || "", s.trackingCode || ""]);
    const csv = [headers.join(","), ...rows.map(r => r.map(v => `"${v}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "report.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppLayout>
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">{t("reports.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">{t("reports.subtitle")}</p>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={exportCsv}>
            <Download className="h-3.5 w-3.5" /> {t("reports.exportCsv")}
          </Button>
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9 h-9" placeholder={t("reports.searchPlaceholder")} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <Select value={status} onValueChange={v => { setStatus(v); setPage(1); }}>
            <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("reports.allStatuses")}</SelectItem>
              <SelectItem value="completed">{t("reports.completed")}</SelectItem>
              <SelectItem value="failed">{t("reports.failed")}</SelectItem>
              <SelectItem value="pending">{t("reports.pending")}</SelectItem>
              <SelectItem value="in_progress">{t("reports.inProgress")}</SelectItem>
              <SelectItem value="skipped">{t("reports.skipped")}</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" className="w-[160px] h-9" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} />
          <Input type="date" className="w-[160px] h-9" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} />
        </div>

        {isLoading ? <LoadingState message={t("reports.loading")} /> : (
          <>
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <DualHorizontalScroll label={t("common.horizontalScroll")}>
                <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="p-3 font-semibold text-muted-foreground text-xs">{t("reports.address")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs">{t("reports.contact")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs">{t("reports.route")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs">{t("common.status")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs">{t("reports.tracking")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs">{t("reports.date")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data?.items?.map(s => (
                    <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                      <td className="p-3 text-sm">{s.address}</td>
                      <td className="p-3 text-xs text-muted-foreground">{s.contactName || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{s.routeName || "—"}</td>
                      <td className="p-3">
                        <span className={cn("inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold", statusColors[s.status] || "")}>
                          {t(`reports.${s.status}`) || s.status}
                        </span>
                      </td>
                      <td className="p-3 text-xs font-mono text-muted-foreground">{s.trackingCode || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{s.createdAt ? new Date(s.createdAt).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                  {(!data?.items || data.items.length === 0) && (
                    <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">{t("reports.noResults")}</td></tr>
                  )}
                </tbody>
                </table>
              </DualHorizontalScroll>
            </div>

            {data && data.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-muted-foreground">
                  {t("reports.showing")} {((data.page - 1) * data.pageSize) + 1}–{Math.min(data.page * data.pageSize, data.total)} {t("reports.of")} {data.total}
                </p>
                <div className="flex gap-1">
                  <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
