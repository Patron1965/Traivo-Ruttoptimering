import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Edit2, Users, FolderOpen } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

const API_BASE = import.meta.env.VITE_API_URL || "";

type UserGroup = { id: string; name: string; memberCount: number; createdAt: string };

function useUserGroups(organizationId?: string) {
  return useQuery<UserGroup[]>({
    queryKey: ["/api/user-groups", organizationId],
    queryFn: () => fetch(`${API_BASE}/api/user-groups?organizationId=${organizationId}`).then(r => r.json()),
    enabled: !!organizationId,
  });
}

export default function UserGroups() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { data: groups, isLoading } = useUserGroups(organizationId);
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<UserGroup | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`${API_BASE}/api/user-groups/${id}?organizationId=${organizationId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/user-groups", organizationId] }),
  });

  if (isLoading) return <AppLayout><LoadingState message={t("userGroups.loading")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">{t("userGroups.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">{t("userGroups.subtitle")}</p>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" /> {t("userGroups.addGroup")}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader><DialogTitle>{t("userGroups.addNewGroup")}</DialogTitle></DialogHeader>
              {organizationId && <GroupForm organizationId={organizationId} onSuccess={() => setIsCreateOpen(false)} />}
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {groups?.map(g => (
            <div key={g.id} className="bg-card rounded-xl border border-border p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <FolderOpen className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{g.name}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Users className="h-3 w-3" /> {g.memberCount} {t("userGroups.members")}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-primary hover:bg-primary/10" onClick={() => setEditingGroup(g)}>
                    <Edit2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive hover:bg-destructive/10" onClick={() => { if (confirm(t("userGroups.deleteConfirm"))) deleteMutation.mutate(g.id); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {(!groups || groups.length === 0) && (
            <div className="col-span-full p-8 text-center text-muted-foreground bg-card rounded-xl border border-border">
              {t("userGroups.noGroups")}
            </div>
          )}
        </div>

        <Dialog open={!!editingGroup} onOpenChange={(open) => !open && setEditingGroup(null)}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader><DialogTitle>{t("userGroups.editGroup")}</DialogTitle></DialogHeader>
            {editingGroup && organizationId && <GroupForm organizationId={organizationId} initialData={editingGroup} onSuccess={() => setEditingGroup(null)} />}
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

function GroupForm({ initialData, onSuccess, organizationId }: { initialData?: UserGroup; onSuccess: () => void; organizationId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialData?.name || "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const url = initialData ? `${API_BASE}/api/user-groups/${initialData.id}?organizationId=${organizationId}` : `${API_BASE}/api/user-groups`;
    await fetch(url, { method: initialData ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, organizationId }) });
    queryClient.invalidateQueries({ queryKey: ["/api/user-groups", organizationId] });
    setSaving(false);
    onSuccess();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pt-4">
      <div className="space-y-2">
        <Label>{t("userGroups.groupName")}</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder={t("userGroups.namePlaceholder")} required />
      </div>
      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={saving}>{saving ? t("common.saving") : t("userGroups.saveGroup")}</Button>
      </div>
    </form>
  );
}
