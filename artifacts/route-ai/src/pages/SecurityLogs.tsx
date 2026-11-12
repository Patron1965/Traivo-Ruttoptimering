import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AppLayout } from "@/components/layout/AppLayout";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { LoadingState, ErrorState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldAlert, FileDown, FileJson, RotateCcw } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { downloadPrivateFile } from "@/lib/private-download";

const API_BASE = import.meta.env.VITE_API_URL || "";
const PAGE_SIZE = 50;

type LogEntry = {
  id: string;
  timestamp: string;
  action: string;
  category: "auth" | "admin" | "data";
  result: "success" | "failure" | "unknown";
  resourceType: string;
  resourceId: string | null;
  userId: string | null;
  userEmail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  method: string;
  path: string;
  statusCode: string | null;
  reason: string | null;
  requestId: string | null;
};

type LogResponse = { logs: LogEntry[]; total: number; page: number; limit: number };
type AppUser = { id: string; name: string; email: string };

const EVENT_TYPES = [
  "login.success",
  "login.failed",
  "logout",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

const ALL = "__all__";

function buildParams(organizationId: string, filters: {
  from: string;
  to: string;
  userId: string;
  category: string;
  action: string;
}): URLSearchParams {
  const params = new URLSearchParams({ organizationId });
  if (filters.from) params.set("from", new Date(filters.from).toISOString());
  if (filters.to) params.set("to", new Date(filters.to).toISOString());
  if (filters.userId && filters.userId !== ALL) params.set("userId", filters.userId);
  if (filters.category && filters.category !== ALL) params.set("category", filters.category);
  if (filters.action && filters.action !== ALL) params.set("action", filters.action);
  return params;
}

export default function SecurityLogs() {
  const { t } = useTranslation();
  const { isAdmin, user } = useAuth();
  const organizationId = user?.organizationId;

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [userId, setUserId] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [action, setAction] = useState(ALL);
  const [page, setPage] = useState(1);

  const filters = useMemo(
    () => ({ from, to, userId, category, action }),
    [from, to, userId, category, action],
  );

  const { data: usersData } = useQuery<AppUser[]>({
    queryKey: ["/api/app-users", organizationId],
    queryFn: () => fetch(`${API_BASE}/api/app-users?organizationId=${organizationId}`).then((r) => r.json()),
    enabled: isAdmin && !!organizationId,
  });

  const { data, isLoading, isError, error } = useQuery<LogResponse>({
    queryKey: ["/api/audit-logs", organizationId, filters, page],
    queryFn: async () => {
      const params = buildParams(organizationId!, filters);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      const res = await fetch(`${API_BASE}/api/audit-logs?${params}`);
       if (!res.ok) {
         const error = new Error("Failed to load logs");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    enabled: isAdmin && !!organizationId,
  });

  if (!isAdmin) {
    return (
      <AppLayout>
        <div className="p-8 flex flex-col items-center justify-center text-center gap-3">
          <ShieldAlert className="h-10 w-10 text-destructive" />
          <p className="text-muted-foreground max-w-md">{t("securityLogs.adminOnly")}</p>
        </div>
      </AppLayout>
    );
  }

  const resetFilters = () => {
    setFrom("");
    setTo("");
    setUserId(ALL);
    setCategory(ALL);
    setAction(ALL);
    setPage(1);
  };

  const download = (format: "csv" | "json") => {
    if (!organizationId) return;
    const params = buildParams(organizationId, filters);
    params.set("format", format);
    void downloadPrivateFile(`${API_BASE}/api/audit-logs/export?${params}`, `sakerhetslogg.${format}`).catch(error => window.alert(error.message));
  };

  const eventLabel = (a: string) => {
    const key = `securityLogs.events.${a}`;
    const label = t(key);
    return label === key ? a : label;
  };

  const reasonLabel = (r: string | null) => {
    if (!r) return "—";
    const key = `securityLogs.reasons.${r}`;
    const label = t(key);
    return label === key ? r : label;
  };

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const rangeFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeTo = Math.min(page * PAGE_SIZE, total);
  const hasNext = page * PAGE_SIZE < total;

  const statusColor = (code: string | null) => {
    if (!code) return "text-muted-foreground";
    if (code.startsWith("2")) return "text-emerald-500";
    if (code === "401" || code === "403" || code === "423") return "text-amber-500";
    if (code.startsWith("4") || code.startsWith("5")) return "text-destructive";
    return "text-muted-foreground";
  };

  const resultColor = (r: string) => {
    if (r === "success") return "text-emerald-500";
    if (r === "failure") return "text-destructive";
    return "text-muted-foreground";
  };

  const categoryColor: Record<string, string> = {
    auth: "bg-blue-500/10 text-blue-500",
    admin: "bg-red-500/10 text-red-500",
    data: "bg-emerald-500/10 text-emerald-500",
  };

  return (
    <AppLayout>
      <div className="p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldAlert className="h-6 w-6 text-primary" />
              {t("securityLogs.title")}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">{t("securityLogs.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => download("csv")}>
              <FileDown className="h-4 w-4" /> {t("securityLogs.exportCsv")}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => download("json")}>
              <FileJson className="h-4 w-4" /> {t("securityLogs.exportJson")}
            </Button>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("securityLogs.from")}</Label>
              <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("securityLogs.to")}</Label>
              <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("securityLogs.user")}</Label>
              <Select value={userId} onValueChange={(v) => { setUserId(v); setPage(1); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("securityLogs.allUsers")}</SelectItem>
                  {(usersData ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("securityLogs.category")}</Label>
              <Select value={category} onValueChange={(v) => { setCategory(v); setPage(1); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("securityLogs.allCategories")}</SelectItem>
                  <SelectItem value="auth">{t("securityLogs.categories.auth")}</SelectItem>
                  <SelectItem value="admin">{t("securityLogs.categories.admin")}</SelectItem>
                  <SelectItem value="data">{t("securityLogs.categories.data")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("securityLogs.eventType")}</Label>
              <Select value={action} onValueChange={(v) => { setAction(v); setPage(1); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("securityLogs.allEvents")}</SelectItem>
                  {EVENT_TYPES.map((a) => (
                    <SelectItem key={a} value={a}>{eventLabel(a)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={resetFilters}>
              <RotateCcw className="h-3.5 w-3.5" /> {t("securityLogs.reset")}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <LoadingState message={t("securityLogs.loading")} />
        ) : isError ? (
          <ErrorState error={error} />
        ) : (
          <>
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <DualHorizontalScroll label={t("common.horizontalScroll")}>
                <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.timestamp")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.category")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.event")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.user")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.result")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.ip")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.reason")}</th>
                    <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("securityLogs.resource")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-muted/30 transition-colors align-top">
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap font-mono">
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${categoryColor[log.category] || ""}`}>
                          {t(`securityLogs.categories.${log.category}`)}
                        </span>
                      </td>
                      <td className="p-3 font-medium whitespace-nowrap">{eventLabel(log.action)}</td>
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{log.userEmail || "—"}</td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        <span className={`font-semibold ${resultColor(log.result)}`}>
                          {t(`securityLogs.results.${log.result}`)}
                        </span>
                        <span className={`ml-1.5 font-mono ${statusColor(log.statusCode)}`}>
                          {log.statusCode || ""}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground font-mono whitespace-nowrap">{log.ipAddress || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{reasonLabel(log.reason)}</td>
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                        {log.resourceType !== "auth" ? (
                          <span className="font-mono">{log.method} {log.path}</span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                  {logs.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-muted-foreground">{t("securityLogs.noLogs")}</td>
                    </tr>
                  )}
                </tbody>
                </table>
              </DualHorizontalScroll>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                {t("securityLogs.showing", { from: rangeFrom, to: rangeTo, total })}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="shrink-0" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  {t("securityLogs.previous")}
                </Button>
                <Button variant="outline" size="sm" className="shrink-0" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                  {t("securityLogs.next")}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
