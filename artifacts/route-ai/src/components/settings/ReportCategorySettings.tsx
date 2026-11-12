import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetReportCategories,
  useUpdateReportCategories,
  getGetReportCategoriesQueryKey,
  type ReportCategoryEntry,
} from "@workspace/api-client-react";
import { Plus, RotateCcw, Archive, AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

type ReportCategory = ReportCategoryEntry;
const MAX_CATEGORIES = 60;
const MAX_LABEL = 80;

const STANDARD_REASONS = [
  "Kunden ej anträffbar",
  "Ingen åtkomst",
  "Adressen hittades inte",
  "Fordon eller säkerhet",
  "Annat",
];

const statusOf = (err: unknown) => (err as { status?: number } | null)?.status;

function newId(): string {
  return crypto.randomUUID();
}

export function ReportCategorySettings() {
  const { user, hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const queryKey = getGetReportCategoriesQueryKey();
  const { data, isLoading, isError, refetch } = useGetReportCategories({ query: { queryKey, enabled: !!user?.organizationId } });
  const [draft, setDraft] = useState<ReportCategory[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [conflict, setConflict] = useState(false);

  useEffect(() => { if (data) { setDraft(data.categories); setConflict(false); } }, [data]);

  const persistedIds = useMemo(() => new Set(data?.categories.map(c => c.id) ?? []), [data]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(data?.categories ?? []), [draft, data]);
  const labels = draft.map(c => c.label.trim().toLocaleLowerCase("sv"));
  const invalid = draft.some(c => !c.label.trim() || c.label.trim().length > MAX_LABEL)
    || new Set(labels).size !== labels.length;

  const mutation = useUpdateReportCategories({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(queryKey, next);
        toast({ title: "Avvikelsekategorier sparade", description: "Förarna får dem vid nästa synkning." });
      },
      onError: (err) => {
        if (statusOf(err) === 409) { setConflict(true); return; }
        toast({ title: "Kunde inte spara kategorierna", description: statusOf(err) === 403 ? "Endast administratörer kan ändra kategorier." : "Försök igen.", variant: "destructive" });
      },
    },
  });
  const save = {
    isPending: mutation.isPending,
    mutate: () => mutation.mutate({ data: { revision: data?.revision ?? 0, categories: draft.map(c => ({ ...c, label: c.label.trim() })) } }),
  };

  const update = (id: string, patch: Partial<ReportCategory>) =>
    setDraft(current => current.map(c => c.id === id ? { ...c, ...patch } : c));

  const add = () => {
    const label = newLabel.trim();
    if (!label || draft.length >= MAX_CATEGORIES) return;
    setDraft(current => [...current, { id: newId(), label, active: true }]);
    setNewLabel("");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Avvikelsekategorier</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Egna orsaker som föraren kan välja vid överhoppade och misslyckade stopp. Kategorin sparas som text i rapporten när den skapas, så senare namnbyten ändrar inte gamla rapporter.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Lock className="h-3 w-3" />Standardorsaker (alltid tillgängliga)</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STANDARD_REASONS.map(r => <span key={r} className="rounded-md border border-border bg-background px-2 py-0.5 text-xs">{r}</span>)}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">En egen kategori vid överhoppat stopp rapporteras som orsak "Annat" med kategorins namn i kommentaren.</p>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Egna kategorier</h2>
          {data && <span className="font-mono text-[11px] text-muted-foreground" data-testid="text-category-revision">rev {data.revision}</span>}
        </div>
        {isLoading && (
          <div className="space-y-2 p-4">{[0, 1, 2].map(i => <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />)}</div>
        )}
        {isError && (
          <div className="flex items-center justify-between gap-3 p-4 text-sm">
            <span className="text-destructive">Kategorierna kunde inte hämtas.</span>
            <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-categories">Försök igen</Button>
          </div>
        )}
        {data && (
          <ul className="divide-y divide-border">
            {draft.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-muted-foreground">Inga egna kategorier ännu. Förarna ser bara standardorsakerna.</li>
            )}
            {draft.map(category => (
              <li key={category.id} className={cn("flex items-center gap-2 px-4 py-2", !category.active && "bg-muted/40")} data-testid={`row-category-${category.id}`}>
                <Input
                  value={category.label}
                  disabled={!isAdmin}
                  maxLength={MAX_LABEL}
                  aria-label="Kategorinamn"
                  onChange={e => update(category.id, { label: e.target.value })}
                  className={cn("h-8 text-sm", !category.active && "text-muted-foreground line-through decoration-muted-foreground/40")}
                  data-testid={`input-category-${category.id}`}
                />
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", category.active ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>
                  {category.active ? "Aktiv" : "Inaktiv"}
                </span>
                {isAdmin && (persistedIds.has(category.id) ? (
                  <Button size="sm" variant="ghost" className="h-8 shrink-0 gap-1 text-xs"
                    onClick={() => update(category.id, { active: !category.active })}
                    data-testid={`button-toggle-category-${category.id}`}>
                    {category.active ? <><Archive className="h-3.5 w-3.5" />Inaktivera</> : <><RotateCcw className="h-3.5 w-3.5" />Återaktivera</>}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="h-8 shrink-0 text-xs"
                    onClick={() => setDraft(current => current.filter(c => c.id !== category.id))}
                    data-testid={`button-discard-category-${category.id}`}>
                    Ångra
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        )}
        {data && isAdmin && (
          <form className="flex gap-2 border-t border-border p-4" onSubmit={e => { e.preventDefault(); add(); }}>
            <Input value={newLabel} maxLength={MAX_LABEL} onChange={e => setNewLabel(e.target.value)} placeholder="Ny kategori, t.ex. Porten låst" className="h-9 text-sm" data-testid="input-new-category" />
            <Button type="submit" size="sm" variant="outline" className="h-9 gap-1" disabled={!newLabel.trim() || draft.length >= MAX_CATEGORIES} data-testid="button-add-category"><Plus className="h-4 w-4" />Lägg till</Button>
          </form>
        )}
      </div>

      {!isAdmin && <p className="text-xs text-muted-foreground">Endast administratörer kan ändra kategorier.</p>}
      {draft.length >= MAX_CATEGORIES && <p className="text-xs text-muted-foreground">Max {MAX_CATEGORIES} kategorier. Inaktivera i stället för att lägga till fler.</p>}
      {invalid && <p className="text-xs text-destructive">Varje kategori behöver ett unikt namn (högst 80 tecken).</p>}
      {conflict && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="alert">
          <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" />Någon annan har ändrat kategorierna. Läs in senaste versionen och gör om ändringen.</span>
          <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-reload-categories">Läs in</Button>
        </div>
      )}
      {isAdmin && data && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(data.categories)} data-testid="button-reset-categories">Återställ</Button>
          <Button disabled={!dirty || invalid || save.isPending || conflict} onClick={() => save.mutate()} data-testid="button-save-categories">
            {save.isPending ? "Sparar..." : "Spara kategorier"}
          </Button>
        </div>
      )}
    </div>
  );
}
