import { AppLayout } from "@/components/layout/AppLayout";
import { useStops, useCreateStop, useUpdateStop, useDeleteStop } from "@/hooks/use-stops";
import { useRoutes } from "@/hooks/use-routes";
import { useVehicles } from "@/hooks/use-vehicles";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, MapPin, Upload, Copy, ExternalLink, FileSpreadsheet } from "lucide-react";
import { useMemo, useState, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FileImportDialog } from "@/components/import/FileImportDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ORG_ID } from "@/lib/constants";
import { type Stop, useImportStops } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { renderToString } from "react-dom/server";

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

function makeIcon(selected: boolean, assigned: boolean) {
  return L.divIcon({
    className: "",
    html: renderToString(
      <div className={cn(
        "flex items-center justify-center h-7 w-7 rounded-full border-2 shadow-lg",
        selected ? "bg-primary border-primary/60 text-white scale-125" :
          assigned ? "bg-emerald-500 border-emerald-400 text-white" :
            "bg-amber-500 border-amber-400 text-white"
      )}>
        <MapPin className="h-3.5 w-3.5" />
      </div>
    ),
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function FlyToStop({ stop }: { stop: { latitude: number; longitude: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (!stop) return;
    map.flyTo([stop.latitude, stop.longitude], 15, { duration: 0.4 });
  }, [stop, map]);
  return null;
}

export default function Stops() {
  const { data: stops, isLoading } = useStops();
  const { data: routes } = useRoutes();
  const { data: vehicles } = useVehicles();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const { t } = useTranslation();

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
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

  const selectedStop = stops?.find((s) => s.id === selectedStopId) || null;

  if (isLoading) return <AppLayout><LoadingState message={t("stops.loadingStops")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold text-foreground">{t("stops.title")}</h1>
                <p className="text-muted-foreground text-sm mt-0.5">{t("stops.subtitle")}</p>
              </div>
              
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setIsImportOpen(true)}>
                  <FileSpreadsheet className="h-3.5 w-3.5" /> {t("import.importButton")}
                </Button>
                <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="gap-1.5 text-xs">
                      <Plus className="h-3.5 w-3.5" /> {t("stops.addStop")}
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

            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("stops.customerAddress")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("stops.timeWindow")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("stops.requirements")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("stops.assignedVehicle")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("stops.tracking")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs text-right">{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {stops?.map((stop) => (
                      <tr
                        key={stop.id}
                        className={cn(
                          "transition-colors cursor-pointer",
                          selectedStopId === stop.id ? "bg-primary/5" : "hover:bg-muted/30"
                        )}
                        onClick={() => setSelectedStopId(selectedStopId === stop.id ? null : stop.id)}
                      >
                        <td className="p-3">
                          <div className="flex gap-2">
                            <MapPin className="h-4 w-4 text-primary/70 mt-0.5 shrink-0" />
                            <div>
                              <p className="font-bold text-sm text-foreground">{stop.notes || t("common.deliveryStop")}</p>
                              <p className="text-xs text-muted-foreground mt-0.5 max-w-[200px] truncate" title={stop.address}>{stop.address}</p>
                            </div>
                          </div>
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">
                          {stop.timeWindowStart ? (
                            <span>{new Date(stop.timeWindowStart).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</span>
                          ) : <span>-</span>}
                          {stop.timeWindowEnd && (
                            <span> – {new Date(stop.timeWindowEnd).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">
                          <span>{stop.serviceDurationMin} {t("common.mins")}</span>
                          {(stop.weightKg || stop.volumeM3) && (
                            <span className="ml-1">· {stop.weightKg || 0}kg / {stop.volumeM3 || 0}m³</span>
                          )}
                        </td>
                        <td className="p-3">
                          {stop.routeId ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary">
                              {vehicleByRouteId.get(stop.routeId) || t("common.assigned")}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-500 uppercase tracking-wider">
                              {t("common.unassigned")}
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          {stop.trackingCode ? (
                            <div className="flex items-center gap-1">
                              <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded font-bold">{stop.trackingCode}</span>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 hover:text-primary"
                                onClick={(e) => {
                                  e.stopPropagation();
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
                                className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-primary/10 hover:text-primary transition-colors"
                                title={t("stops.openTrackingPage")}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs italic">-</span>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-7 w-7 hover:text-primary hover:bg-primary/10"
                              onClick={(e) => { e.stopPropagation(); setEditingStop(stop); }}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-7 w-7 hover:text-destructive hover:bg-destructive/10"
                              onClick={(e) => {
                                e.stopPropagation();
                                if(confirm(t("stops.deleteConfirm"))) deleteMutation.mutate({ id: stop.id });
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
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

            <FileImportDialog
              open={isImportOpen}
              onOpenChange={setIsImportOpen}
              onSuccess={() => setIsImportOpen(false)}
            />
          </div>
        </div>

        <div className="w-[40%] shrink-0 border-l border-border relative">
          <MapContainer
            center={[59.33, 18.07]}
            zoom={11}
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />
            <FlyToStop stop={selectedStop} />
            {stops?.filter((s) => s.latitude && s.longitude).map((stop) => (
              <Marker
                key={stop.id}
                position={[stop.latitude, stop.longitude]}
                icon={makeIcon(selectedStopId === stop.id, !!stop.routeId)}
                eventHandlers={{
                  click: () => setSelectedStopId(selectedStopId === stop.id ? null : stop.id),
                }}
              >
                <Popup className="dark-popup">
                  <div className="text-xs">
                    <p className="font-bold">{stop.notes || stop.address}</p>
                    <p className="text-muted-foreground">{stop.address}</p>
                    {stop.weightKg && <p>{stop.weightKg} kg</p>}
                    {stop.routeId ? (
                      <p className="text-primary">{vehicleByRouteId.get(stop.routeId) || t("common.assigned")}</p>
                    ) : (
                      <p className="text-amber-500">{t("common.unassigned")}</p>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
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
