import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Edit2, User, Mail, Shield, ShieldAlert, FileDown, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { useAuth, type UserRole } from "@/lib/auth-context";
import { localizeError } from "@/lib/localize-error";

const API_BASE = import.meta.env.VITE_API_URL || "";

type AppUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  groupId: string | null;
  groupName: string | null;
  driverProfileId: string | null;
  driverName: string | null;
  driverIsActive: boolean | null;
  resourceId: string | null;
  resourceName: string | null;
  createdAt: string;
};

type UserGroup = { id: string; name: string };
type ResourceOption = { id: string; name: string; licensePlate?: string | null; isActive: boolean };

const ROLES: UserRole[] = ["admin", "dispatcher", "driver", "viewer"];

export type { AppUser };

export function useAppUsers(organizationId: string | undefined, enabled: boolean) {
  return useQuery<AppUser[]>({
    queryKey: ["/api/app-users", organizationId],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/app-users?organizationId=${organizationId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Kunde inte hämta användare");
      return response.json();
    },
    enabled: enabled && !!organizationId,
    refetchInterval: 15000,
  });
}

function useUserGroups(organizationId: string | undefined, enabled: boolean) {
  return useQuery<UserGroup[]>({
    queryKey: ["/api/user-groups", organizationId],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/user-groups?organizationId=${organizationId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Kunde inte hämta användargrupper");
      return response.json();
    },
    enabled: enabled && !!organizationId,
  });
}

function useResourceOptions(organizationId: string | undefined, enabled: boolean) {
  return useQuery<ResourceOption[]>({
    queryKey: ["/api/vehicles", organizationId, "account-linking"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/vehicles?organizationId=${organizationId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Kunde inte hämta resurser");
      return response.json();
    },
    enabled: enabled && !!organizationId,
  });
}

export default function Users() {
  const { t } = useTranslation();
  const { isAdmin, user } = useAuth();
  const organizationId = user?.organizationId;
  const { data: users, isLoading } = useAppUsers(organizationId, isAdmin);
  const { data: groups } = useUserGroups(organizationId, isAdmin);
  const { data: resources } = useResourceOptions(organizationId, isAdmin);
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AppUser | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`${API_BASE}/api/app-users/${id}?organizationId=${organizationId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Kunde inte radera användaren (${response.status})`);
      }
    },
    onMutate: () => setDeleteError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/app-users", organizationId] }),
    onError: (error) => setDeleteError(localizeError(error, t, { fallbackKey: "common.errorRequestFailed" })),
  });

  if (!isAdmin) {
    return (
      <AppLayout>
        <div className="p-8 flex flex-col items-center justify-center text-center gap-3">
          <ShieldAlert className="h-10 w-10 text-destructive" />
          <p className="text-muted-foreground max-w-md">{t("users.adminOnly")}</p>
        </div>
      </AppLayout>
    );
  }

  if (isLoading) return <AppLayout><LoadingState message={t("users.loading")} /></AppLayout>;

  const roleColors: Record<string, string> = {
    admin: "bg-red-500/10 text-red-500",
    dispatcher: "bg-blue-500/10 text-blue-500",
    driver: "bg-emerald-500/10 text-emerald-500",
    viewer: "bg-slate-500/10 text-slate-400",
  };

  const exportCsv = () => {
    const rows = users ?? [];
    const cols: Array<keyof AppUser> = ["name", "email", "role", "groupName", "createdAt"];
    const cell = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppLayout>
      <div className="p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold">{t("users.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">{t("users.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5 text-xs shrink-0" onClick={exportCsv} disabled={!users?.length}>
              <FileDown className="h-3.5 w-3.5" /> {t("users.exportCsv")}
            </Button>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5 text-xs shrink-0">
                  <Plus className="h-3.5 w-3.5" /> {t("users.addUser")}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader><DialogTitle>{t("users.addNewUser")}</DialogTitle></DialogHeader>
                {organizationId && <UserForm organizationId={organizationId} groups={groups || []} resources={resources || []} onSuccess={() => setIsCreateOpen(false)} />}
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {deleteError && (
          <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {deleteError}
          </p>
        )}

        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <DualHorizontalScroll label={t("common.horizontalScroll")}>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("users.user")}</th>
                  <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("users.email")}</th>
                  <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("users.role")}</th>
                  <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("users.group")}</th>
                  <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">Resurs</th>
                  <th className="p-3 font-semibold text-muted-foreground text-xs text-right sticky right-0 bg-muted z-10 shadow-[-1px_0_0_0_hsl(var(--border))]">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users?.map((u) => (
                  <tr key={u.id} className="group hover:bg-muted/30 transition-colors">
                    <td className="p-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="h-4 w-4 text-primary" />
                        </div>
                        <span className="font-medium text-sm">{u.name}</span>
                      </div>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                      <div className="flex items-center gap-1"><Mail className="h-3 w-3 shrink-0" />{u.email}</div>
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold", roleColors[u.role] || "")}>
                        <Shield className="h-3 w-3 shrink-0" />{t(`users.roles.${u.role}`)}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{u.groupName || "—"}</td>
                    <td className="p-3 text-xs whitespace-nowrap">
                      {u.resourceName ? (
                        <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400" data-testid={`text-user-resource-${u.id}`}>
                          <Link2 className="h-3.5 w-3.5" />
                          {u.resourceId ? <Link href={`/drivers?resourceId=${encodeURIComponent(u.resourceId)}`} className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm" title="Öppna under Förare">{u.resourceName}</Link> : u.resourceName}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Ej länkad</span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-right sticky right-0 z-10 shadow-[-1px_0_0_0_hsl(var(--border))] bg-card group-hover:bg-muted">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 hover:text-primary hover:bg-primary/10" aria-label={t("common.edit")} title={t("common.edit")} onClick={() => setEditingUser(u)}>
                          <Edit2 className="h-5 w-5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 hover:text-destructive hover:bg-destructive/10" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => { if (confirm(t("users.deleteConfirm"))) deleteMutation.mutate(u.id); }}>
                          <Trash2 className="h-5 w-5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {(!users || users.length === 0) && (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">{t("users.noUsers")}</td></tr>
                )}
              </tbody>
            </table>
          </DualHorizontalScroll>
        </div>

        <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader><DialogTitle>{t("users.editUser")}</DialogTitle></DialogHeader>
            {editingUser && organizationId && <UserForm organizationId={organizationId} initialData={editingUser} groups={groups || []} resources={resources || []} onSuccess={() => setEditingUser(null)} />}
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

function UserForm({ initialData, groups, resources, onSuccess, organizationId }: { initialData?: AppUser; groups: UserGroup[]; resources: ResourceOption[]; onSuccess: () => void; organizationId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialData?.name || "");
  const [email, setEmail] = useState(initialData?.email || "");
  const [role, setRole] = useState<UserRole>(initialData?.role || "dispatcher");
  const [groupId, setGroupId] = useState(initialData?.groupId || "__none__");
  const [resourceId, setResourceId] = useState(initialData?.resourceId || "__none__");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role,
        groupId: groupId === "__none__" ? null : groupId,
        resourceId: resourceId === "__none__" ? null : resourceId,
      };
      if (password.length > 0) body.password = password;
      const url = initialData
        ? `${API_BASE}/api/app-users/${initialData.id}`
        : `${API_BASE}/api/app-users`;
      const res = await fetch(url, {
        method: initialData ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Kunde inte spara användaren (${res.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/app-users", organizationId] });
      onSuccess();
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === "AbortError"
          ? t("common.errorTimeout")
          : localizeError(err, t, { fallbackKey: "common.errorRequestFailed" }),
      );
    } finally {
      window.clearTimeout(timeout);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pt-4">
      <div className="space-y-2">
        <Label>{t("users.name")}</Label>
        <Input value={name} onChange={e => setName(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>{t("users.email")}</Label>
        <Input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("users.role")}</Label>
          <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ROLES.map(r => <SelectItem key={r} value={r}>{t(`users.roles.${r}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t("users.group")}</Label>
          <Select value={groupId} onValueChange={setGroupId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("users.noGroup")}</SelectItem>
              {groups.map(g => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label>Resurs</Label>
        <Select
          value={resourceId}
          onValueChange={(value) => {
            setResourceId(value);
            if (value !== "__none__") setRole("driver");
          }}
        >
          <SelectTrigger><SelectValue placeholder="Välj resurs" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Ej länkad</SelectItem>
            {resources.map((resource) => (
              <SelectItem key={resource.id} value={resource.id} disabled={!resource.isActive && resource.id !== initialData?.resourceId}>
                {resource.name}{resource.licensePlate ? ` · ${resource.licensePlate}` : ""}{!resource.isActive ? " (inaktiv)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Kontot får se rutter för vald resurs. Länkning ändrar inte rutt- eller historikdata.
        </p>
      </div>
      <div className="space-y-2">
        <Label>{t("users.password")}</Label>
        <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        <p className="text-[11px] text-muted-foreground">
          {initialData ? t("users.passwordHintEdit") : t("users.passwordHintCreate")}
        </p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={saving}>{saving ? t("common.saving") : t("users.saveUser")}</Button>
      </div>
    </form>
  );
}
