import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Edit2, User, Mail, Shield } from "lucide-react";
import { ORG_ID } from "@/lib/constants";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.VITE_API_URL || "";

type AppUser = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "dispatcher" | "driver";
  groupId: string | null;
  groupName: string | null;
  createdAt: string;
};

type UserGroup = { id: string; name: string };

function useAppUsers() {
  return useQuery<AppUser[]>({
    queryKey: ["/api/app-users"],
    queryFn: () => fetch(`${API_BASE}/api/app-users?organizationId=${ORG_ID}`).then(r => r.json()),
  });
}

function useUserGroups() {
  return useQuery<UserGroup[]>({
    queryKey: ["/api/user-groups"],
    queryFn: () => fetch(`${API_BASE}/api/user-groups?organizationId=${ORG_ID}`).then(r => r.json()),
  });
}

export default function Users() {
  const { t } = useTranslation();
  const { data: users, isLoading } = useAppUsers();
  const { data: groups } = useUserGroups();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AppUser | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`${API_BASE}/api/app-users/${id}?organizationId=${ORG_ID}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/app-users"] }),
  });

  if (isLoading) return <AppLayout><LoadingState message={t("users.loading")} /></AppLayout>;

  const roleColors: Record<string, string> = {
    admin: "bg-red-500/10 text-red-500",
    dispatcher: "bg-blue-500/10 text-blue-500",
    driver: "bg-emerald-500/10 text-emerald-500",
  };

  return (
    <AppLayout>
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">{t("users.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">{t("users.subtitle")}</p>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" /> {t("users.addUser")}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader><DialogTitle>{t("users.addNewUser")}</DialogTitle></DialogHeader>
              <UserForm groups={groups || []} onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="p-3 font-semibold text-muted-foreground text-xs">{t("users.user")}</th>
                <th className="p-3 font-semibold text-muted-foreground text-xs">{t("users.email")}</th>
                <th className="p-3 font-semibold text-muted-foreground text-xs">{t("users.role")}</th>
                <th className="p-3 font-semibold text-muted-foreground text-xs">{t("users.group")}</th>
                <th className="p-3 font-semibold text-muted-foreground text-xs text-right">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users?.map((u) => (
                <tr key={u.id} className="hover:bg-muted/30 transition-colors">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <User className="h-4 w-4 text-primary" />
                      </div>
                      <span className="font-medium text-sm">{u.name}</span>
                    </div>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1"><Mail className="h-3 w-3" />{u.email}</div>
                  </td>
                  <td className="p-3">
                    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold", roleColors[u.role] || "")}>
                      <Shield className="h-3 w-3" />{t(`users.roles.${u.role}`)}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{u.groupName || "—"}</td>
                  <td className="p-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-primary hover:bg-primary/10" onClick={() => setEditingUser(u)}>
                        <Edit2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive hover:bg-destructive/10" onClick={() => { if (confirm(t("users.deleteConfirm"))) deleteMutation.mutate(u.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {(!users || users.length === 0) && (
                <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">{t("users.noUsers")}</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader><DialogTitle>{t("users.editUser")}</DialogTitle></DialogHeader>
            {editingUser && <UserForm initialData={editingUser} groups={groups || []} onSuccess={() => setEditingUser(null)} />}
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

function UserForm({ initialData, groups, onSuccess }: { initialData?: AppUser; groups: UserGroup[]; onSuccess: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialData?.name || "");
  const [email, setEmail] = useState(initialData?.email || "");
  const [role, setRole] = useState(initialData?.role || "dispatcher");
  const [groupId, setGroupId] = useState(initialData?.groupId || "__none__");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const body = { name, email, role, groupId: groupId === "__none__" ? null : groupId, organizationId: ORG_ID };
    const url = initialData ? `${API_BASE}/api/app-users/${initialData.id}?organizationId=${ORG_ID}` : `${API_BASE}/api/app-users`;
    await fetch(url, { method: initialData ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    queryClient.invalidateQueries({ queryKey: ["/api/app-users"] });
    setSaving(false);
    onSuccess();
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
          <Select value={role} onValueChange={(v) => setRole(v as any)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">{t("users.roles.admin")}</SelectItem>
              <SelectItem value="dispatcher">{t("users.roles.dispatcher")}</SelectItem>
              <SelectItem value="driver">{t("users.roles.driver")}</SelectItem>
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
      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={saving}>{saving ? t("common.saving") : t("users.saveUser")}</Button>
      </div>
    </form>
  );
}
