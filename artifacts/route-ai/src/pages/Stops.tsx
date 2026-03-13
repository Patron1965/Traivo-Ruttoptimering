import { AppLayout } from "@/components/layout/AppLayout";
import { useStops, useCreateStop, useUpdateStop, useDeleteStop } from "@/hooks/use-stops";
import { useRoutes } from "@/hooks/use-routes";
import { useVehicles } from "@/hooks/use-vehicles";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, MapPin, Upload, Copy, ExternalLink } from "lucide-react";
import { useMemo, useState, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ORG_ID } from "@/lib/constants";
import { type Stop, useImportStops } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

const optionalNumber = z.preprocess(
  (val) => (val === "" || val === null || val === undefined ? null : Number(val)),
  z.number().nullable().optional()
);

const optionalString = z.preprocess(
  (val) => (val === "" ? null : val),
  z.string().nullable().optional()
);

const createStopSchema = (t: (key: string) => string) => z.object({
  address: z.string().min(1, t("stops.addressRequired")),
  notes: z.string().optional(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  serviceDurationMin: z.coerce.number().min(1),
  weightKg: optionalNumber,
  volumeM3: optionalNumber,
  timeWindowStart: optionalString,
  timeWindowEnd: optionalString,
});

type StopFormValues = z.infer<ReturnType<typeof createStopSchema>>;

export default function Stops() {
  const { data: stops, isLoading } = useStops();
  const { data: routes } = useRoutes();
  const { data: vehicles } = useVehicles();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const { t } = useTranslation();

  const [isImportOpen, setIsImportOpen] = useState(false);
  const deleteMutation = useDeleteStop();

  const vehicleByRouteId = useMemo(() => {
    const map = new Map<string, string>();
    if (routes && vehicles) {
      const vMap = new Map(vehicles.map(v => [v.id, v.name]));
      routes.forEach(r => {
        if (r.vehicleId) map.set(r.id, vMap.get(r.vehicleId) || t("common.unknown"));
      });
    }
    return map;
  }, [routes, vehicles, t]);

  if (isLoading) return <AppLayout><LoadingState message={t("stops.loadingStops")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="p-6 md:p-8 max-w-7xl mx-auto animate-in fade-in">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">{t("stops.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("stops.subtitle")}</p>
          </div>
          
          <div className="flex gap-2">
            <Button variant="outline" className="gap-2" onClick={() => setIsImportOpen(true)}>
              <Upload className="h-4 w-4" /> {t("stops.importCsv")}
            </Button>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg hover:shadow-primary/25">
                  <Plus className="h-4 w-4" /> {t("stops.addStop")}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                  <DialogTitle>{t("stops.addNewStop")}</DialogTitle>
                </DialogHeader>
                <StopForm onSuccess={() => setIsCreateOpen(false)} />
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-card-border overflow-hidden shadow-xl shadow-black/5">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("stops.customerAddress")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("stops.timeWindow")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("stops.requirements")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("stops.assignedVehicle")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("stops.tracking")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm text-right">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stops?.map((stop) => (
                  <tr key={stop.id} className="hover:bg-muted/30 transition-colors">
                    <td className="p-4">
                      <div className="flex gap-3">
                        <div className="mt-1">
                          <MapPin className="h-5 w-5 text-primary/70" />
                        </div>
                        <div>
                          <p className="font-bold text-foreground">{stop.notes || t("common.deliveryStop")}</p>
                          <p className="text-sm text-muted-foreground mt-0.5 max-w-xs truncate" title={stop.address}>{stop.address}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-xs text-muted-foreground space-y-1">
                      {stop.timeWindowStart ? (
                        <p>{new Date(stop.timeWindowStart).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</p>
                      ) : <p>-</p>}
                      {stop.timeWindowEnd ? (
                        <p>{t("common.to")} {new Date(stop.timeWindowEnd).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</p>
                      ) : null}
                    </td>
                    <td className="p-4 text-sm space-y-1 text-muted-foreground">
                      <p>{stop.serviceDurationMin} {t("common.mins")}</p>
                      {(stop.weightKg || stop.volumeM3) && (
                        <p>{stop.weightKg || 0}kg / {stop.volumeM3 || 0}m³</p>
                      )}
                    </td>
                    <td className="p-4">
                      {stop.routeId ? (
                        <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary">
                          {vehicleByRouteId.get(stop.routeId) || t("common.assigned")}
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-500 uppercase tracking-wider">
                          {t("common.unassigned")}
                        </span>
                      )}
                    </td>
                    <td className="p-4">
                      {stop.trackingCode ? (
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs bg-muted px-2 py-1 rounded font-bold">{stop.trackingCode}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 hover:text-primary"
                            onClick={() => {
                              const url = `${window.location.origin}${import.meta.env.BASE_URL}track/${stop.trackingCode}`;
                              navigator.clipboard.writeText(url);
                            }}
                            title={t("stops.copyTrackingLink")}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                          <a
                            href={`${import.meta.env.BASE_URL}track/${stop.trackingCode}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-primary/10 hover:text-primary transition-colors"
                            title={t("stops.openTrackingPage")}
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs italic">-</span>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="hover:text-primary hover:bg-primary/10"
                          onClick={() => setEditingStop(stop)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="hover:text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            if(confirm(t("stops.deleteConfirm"))) deleteMutation.mutate({ id: stop.id });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {(!stops || stops.length === 0) && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">{t("stops.noStops")}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <Dialog open={!!editingStop} onOpenChange={(open) => !open && setEditingStop(null)}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>{t("stops.editStop")}</DialogTitle>
            </DialogHeader>
            {editingStop && (
              <StopForm 
                initialData={editingStop} 
                onSuccess={() => setEditingStop(null)} 
              />
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
          <DialogContent className="sm:max-w-[550px]">
            <DialogHeader>
              <DialogTitle>{t("stops.importStopsFromCsv")}</DialogTitle>
            </DialogHeader>
            <CsvImportForm onSuccess={() => setIsImportOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

function StopForm({ initialData, onSuccess }: { initialData?: Stop, onSuccess: () => void }) {
  const createMutation = useCreateStop();
  const updateMutation = useUpdateStop();
  const { t } = useTranslation();
  
  const { register, handleSubmit, formState: { errors } } = useForm<StopFormValues>({
    resolver: zodResolver(createStopSchema(t)),
    defaultValues: initialData ? {
      ...initialData,
      notes: initialData.notes || "",
      weightKg: initialData.weightKg || null,
      volumeM3: initialData.volumeM3 || null,
    } : {
      serviceDurationMin: 15,
      latitude: 59.33258,
      longitude: 18.0649,
    }
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = (data: StopFormValues) => {
    if (initialData) {
      updateMutation.mutate({ id: initialData.id, data }, { onSuccess });
    } else {
      createMutation.mutate({ data: { ...data, organizationId: ORG_ID } }, { onSuccess });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4">
      <div className="space-y-2">
        <Label>{t("stops.notes")}</Label>
        <Input {...register("notes")} placeholder={t("stops.notesPlaceholder")} />
      </div>

      <div className="space-y-2">
        <Label>{t("stops.address")}</Label>
        <Input {...register("address")} placeholder={t("stops.addressPlaceholder")} />
        {errors.address && <span className="text-xs text-destructive">{errors.address.message}</span>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("stops.latitude")}</Label>
          <Input type="number" step="any" {...register("latitude")} />
        </div>
        <div className="space-y-2">
          <Label>{t("stops.longitude")}</Label>
          <Input type="number" step="any" {...register("longitude")} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("stops.serviceDuration")}</Label>
        <Input type="number" {...register("serviceDurationMin")} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("stops.timeWindowStart")}</Label>
          <Input type="datetime-local" {...register("timeWindowStart")} />
        </div>
        <div className="space-y-2">
          <Label>{t("stops.timeWindowEnd")}</Label>
          <Input type="datetime-local" {...register("timeWindowEnd")} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("stops.weightKg")}</Label>
          <Input type="number" step="any" {...register("weightKg")} placeholder={t("stops.weightPlaceholder")} />
        </div>
        <div className="space-y-2">
          <Label>{t("stops.volumeM3")}</Label>
          <Input type="number" step="any" {...register("volumeM3")} placeholder={t("stops.volumePlaceholder")} />
        </div>
      </div>

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? t("common.saving") : t("stops.saveStop")}
        </Button>
      </div>
    </form>
  );
}

function CsvImportForm({ onSuccess }: { onSuccess: () => void }) {
  const importMutation = useImportStops();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [preview, setPreview] = useState<Array<{ address: string; latitude: number; longitude: number; notes?: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setPreview([]);
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const lines = text.trim().split("\n");
        if (lines.length < 2) {
          setError(t("stops.csvNeedHeaderAndData"));
          return;
        }
        const header = lines[0].split(",").map(h => h.trim().toLowerCase());
        const addrIdx = header.indexOf("address");
        const latIdx = header.indexOf("latitude");
        const lngIdx = header.indexOf("longitude");

        if (addrIdx === -1 || latIdx === -1 || lngIdx === -1) {
          setError(t("stops.csvMissingColumns"));
          return;
        }

        const notesIdx = header.indexOf("notes");
        const twsIdx = header.indexOf("time_window_start");
        const tweIdx = header.indexOf("time_window_end");
        const sdIdx = header.indexOf("service_duration_min");

        const parsed = lines.slice(1).filter(l => l.trim()).map(line => {
          const cols = line.split(",").map(c => c.trim());
          return {
            address: cols[addrIdx],
            latitude: parseFloat(cols[latIdx]),
            longitude: parseFloat(cols[lngIdx]),
            notes: notesIdx >= 0 ? cols[notesIdx] || undefined : undefined,
            timeWindowStart: twsIdx >= 0 && cols[twsIdx] ? cols[twsIdx] : undefined,
            timeWindowEnd: tweIdx >= 0 && cols[tweIdx] ? cols[tweIdx] : undefined,
            serviceDurationMin: sdIdx >= 0 ? parseInt(cols[sdIdx]) || undefined : undefined,
          };
        });

        const invalid = parsed.filter(p => !p.address || isNaN(p.latitude) || isNaN(p.longitude));
        if (invalid.length > 0) {
          setError(t("stops.csvInvalidRows", { count: invalid.length }));
          return;
        }

        setPreview(parsed);
      } catch {
        setError(t("stops.csvParseFailed"));
      }
    };
    reader.readAsText(file);
  }, [t]);

  const handleImport = () => {
    importMutation.mutate(
      { data: { organizationId: ORG_ID, stops: preview } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
          onSuccess();
        },
        onError: () => setError(t("stops.importFailed")),
      }
    );
  };

  return (
    <div className="space-y-4 pt-2">
      <div className="space-y-2">
        <Label>{t("stops.csvFile")}</Label>
        <Input type="file" accept=".csv" onChange={handleFileChange} />
        <p className="text-xs text-muted-foreground">
          {t("stops.csvColumnsRequired")}
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {preview.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("stops.stopsReadyToImport", { count: preview.length })}</p>
          <div className="max-h-48 overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="p-2 text-left">#</th>
                  <th className="p-2 text-left">{t("stops.address")}</th>
                  <th className="p-2 text-left">{t("common.lat")}</th>
                  <th className="p-2 text-left">{t("common.lng")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.slice(0, 20).map((row, i) => (
                  <tr key={i} className="hover:bg-muted/30">
                    <td className="p-2 text-muted-foreground">{i + 1}</td>
                    <td className="p-2 truncate max-w-[200px]">{row.address}</td>
                    <td className="p-2">{row.latitude.toFixed(4)}</td>
                    <td className="p-2">{row.longitude.toFixed(4)}</td>
                  </tr>
                ))}
                {preview.length > 20 && (
                  <tr><td colSpan={4} className="p-2 text-center text-muted-foreground">{t("common.andMore", { count: preview.length - 20 })}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button
          onClick={handleImport}
          disabled={preview.length === 0 || importMutation.isPending}
          className="gap-2 bg-primary text-primary-foreground"
        >
          <Upload className="h-4 w-4" />
          {importMutation.isPending ? t("stops.importing") : (preview.length !== 1 ? t("stops.importStopsPlural", { count: preview.length }) : t("stops.importStops", { count: preview.length }))}
        </Button>
      </div>
    </div>
  );
}
