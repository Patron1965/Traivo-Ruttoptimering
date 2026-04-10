import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles, useCreateVehicle, useUpdateVehicle, useDeleteVehicle } from "@/hooks/use-vehicles";
import { useDrivers } from "@/hooks/use-drivers";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, Battery, Fuel, Truck, User, Gauge, Weight, Box, X } from "lucide-react";
import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ORG_ID } from "@/lib/constants";
import { type Vehicle } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const createVehicleSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t("vehicles.nameRequired")),
  licensePlate: z.string().min(1, t("vehicles.licensePlateRequired")),
  vehicleType: z.enum(["fossil", "electric"]),
  capacityKg: z.coerce.number().min(0),
  capacityVolume: z.coerce.number().min(0),
  batteryCapacityKwh: z.coerce.number().optional().nullable(),
  rangeKm: z.coerce.number().optional().nullable(),
});

type VehicleFormValues = z.infer<ReturnType<typeof createVehicleSchema>>;

export default function Vehicles() {
  const { data: vehicles, isLoading } = useVehicles();
  const { data: drivers } = useDrivers();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const { t } = useTranslation();

  const deleteMutation = useDeleteVehicle();

  const driverByVehicleId = useMemo(() => {
    const map = new Map<string, { name: string; phone: string | null; email: string | null }>();
    drivers?.filter((d) => d.isActive && d.vehicleId).forEach((d) => {
      map.set(d.vehicleId!, { name: d.name, phone: d.phone ?? null, email: d.email ?? null });
    });
    return map;
  }, [drivers]);

  const selectedVehicle = vehicles?.find((v) => v.id === selectedVehicleId);

  if (isLoading) return <AppLayout><LoadingState message={t("vehicles.loadingFleet")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold text-foreground">{t("vehicles.title")}</h1>
                <p className="text-muted-foreground text-sm mt-0.5">{t("vehicles.subtitle")}</p>
              </div>
              
              <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5 text-xs">
                    <Plus className="h-3.5 w-3.5" /> {t("vehicles.addVehicle")}
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[500px]">
                  <DialogHeader>
                    <DialogTitle>{t("vehicles.addNewVehicle")}</DialogTitle>
                  </DialogHeader>
                  <VehicleForm onSuccess={() => setIsCreateOpen(false)} />
                </DialogContent>
              </Dialog>
            </div>

            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("common.vehicle")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("common.type")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("vehicles.capacity")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("vehicles.rangeBattery")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs text-right">{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {vehicles?.map((v) => (
                      <tr
                        key={v.id}
                        className={cn(
                          "transition-colors cursor-pointer",
                          selectedVehicleId === v.id ? "bg-primary/5" : "hover:bg-muted/30"
                        )}
                        onClick={() => setSelectedVehicleId(selectedVehicleId === v.id ? null : v.id)}
                      >
                        <td className="p-3">
                          <p className="font-bold text-sm text-foreground">{v.name}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5 px-1.5 py-0.5 bg-muted inline-block rounded">{v.licensePlate}</p>
                        </td>
                        <td className="p-3">
                          <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            v.vehicleType === 'electric' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                          }`}>
                            {v.vehicleType === 'electric' ? <Battery className="h-3 w-3" /> : <Fuel className="h-3 w-3" />}
                            {v.vehicleType === 'electric' ? t("common.electric") : t("common.fossil")}
                          </div>
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">
                          <span>{v.capacityKg} kg · {v.capacityVolume} m³</span>
                        </td>
                        <td className="p-3 text-xs">
                          {v.vehicleType === 'electric' ? (
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${
                                    (v.currentBatteryPercent ?? 0) > 50
                                      ? 'bg-emerald-500'
                                      : (v.currentBatteryPercent ?? 0) > 20
                                        ? 'bg-amber-500'
                                        : 'bg-destructive'
                                  }`}
                                  style={{ width: `${v.currentBatteryPercent ?? 0}%` }}
                                />
                              </div>
                              <span className="text-[10px] font-semibold">{v.currentBatteryPercent ?? 0}%</span>
                            </div>
                          ) : <span className="text-muted-foreground italic text-xs">{t("common.na")}</span>}
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-7 w-7 hover:text-primary hover:bg-primary/10"
                              onClick={(e) => { e.stopPropagation(); setEditingVehicle(v); }}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-7 w-7 hover:text-destructive hover:bg-destructive/10"
                              onClick={(e) => {
                                e.stopPropagation();
                                if(confirm(t("vehicles.deleteConfirm"))) deleteMutation.mutate({ id: v.id });
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {(!vehicles || vehicles.length === 0) && (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-muted-foreground">{t("vehicles.noVehicles")}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <Dialog open={!!editingVehicle} onOpenChange={(open) => !open && setEditingVehicle(null)}>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                  <DialogTitle>{t("vehicles.editVehicle")}</DialogTitle>
                </DialogHeader>
                {editingVehicle && (
                  <VehicleForm 
                    initialData={editingVehicle} 
                    onSuccess={() => setEditingVehicle(null)} 
                  />
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className={cn(
          "shrink-0 border-l border-border bg-card overflow-y-auto transition-all duration-200",
          selectedVehicle ? "w-[380px]" : "w-0"
        )}>
          {selectedVehicle && (
            <div className="p-5 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-lg">{selectedVehicle.name}</h2>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedVehicleId(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 border border-border">
                  <Truck className="h-8 w-8 text-primary" />
                  <div>
                    <p className="font-semibold text-sm">{selectedVehicle.licensePlate}</p>
                    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold mt-1 ${
                      selectedVehicle.vehicleType === 'electric' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                    }`}>
                      {selectedVehicle.vehicleType === 'electric' ? <Battery className="h-3 w-3" /> : <Fuel className="h-3 w-3" />}
                      {selectedVehicle.vehicleType === 'electric' ? t("common.electric") : t("common.fossil")}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <DetailCard
                    icon={<Weight className="h-4 w-4 text-blue-400" />}
                    label={t("common.weight")}
                    value={`${selectedVehicle.capacityKg} kg`}
                  />
                  <DetailCard
                    icon={<Box className="h-4 w-4 text-violet-400" />}
                    label={t("common.volume")}
                    value={`${selectedVehicle.capacityVolume} m³`}
                  />
                </div>

                {selectedVehicle.vehicleType === 'electric' && (
                  <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 space-y-2">
                    <p className="text-xs font-medium text-emerald-400">{t("vehicles.batteryStatus") || "Batteristatus"}</p>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            (selectedVehicle.currentBatteryPercent ?? 0) > 50
                              ? 'bg-emerald-500'
                              : (selectedVehicle.currentBatteryPercent ?? 0) > 20
                                ? 'bg-amber-500'
                                : 'bg-destructive'
                          }`}
                          style={{ width: `${selectedVehicle.currentBatteryPercent ?? 0}%` }}
                        />
                      </div>
                      <span className="text-sm font-bold">{selectedVehicle.currentBatteryPercent ?? 0}%</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>{selectedVehicle.batteryCapacityKwh} kWh</span>
                      <span>{selectedVehicle.rangeKm ? `${Math.round((selectedVehicle.rangeKm * (selectedVehicle.currentBatteryPercent ?? 100)) / 100)} km ${t("common.remaining")}` : ''}</span>
                    </div>
                  </div>
                )}

                {driverByVehicleId.has(selectedVehicle.id) && (() => {
                  const driver = driverByVehicleId.get(selectedVehicle.id)!;
                  return (
                    <div className="p-3 rounded-xl bg-violet-500/5 border border-violet-500/20 space-y-1">
                      <p className="text-xs font-medium text-violet-400">{t("drivers.assignedDriver") || "Tilldelad förare"}</p>
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-violet-500/10 flex items-center justify-center">
                          <User className="h-4 w-4 text-violet-400" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{driver.name}</p>
                          {driver.phone && <p className="text-[10px] text-muted-foreground">{driver.phone}</p>}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function DetailCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="p-3 rounded-xl bg-muted/20 border border-border space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-sm font-bold">{value}</p>
    </div>
  );
}

function VehicleForm({ initialData, onSuccess }: { initialData?: Vehicle, onSuccess: () => void }) {
  const createMutation = useCreateVehicle();
  const updateMutation = useUpdateVehicle();
  const { t } = useTranslation();
  
  const { register, handleSubmit, watch, control, formState: { errors } } = useForm<VehicleFormValues>({
    resolver: zodResolver(createVehicleSchema(t)),
    defaultValues: initialData || {
      vehicleType: "fossil",
      capacityKg: 1000,
      capacityVolume: 10,
    }
  });

  const isElectric = watch("vehicleType") === "electric";
  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = (data: VehicleFormValues) => {
    if (initialData) {
      updateMutation.mutate({ id: initialData.id, data }, { onSuccess });
    } else {
      createMutation.mutate({ data: { ...data, organizationId: ORG_ID } }, { onSuccess });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("vehicles.vehicleName")}</Label>
          <Input {...register("name")} placeholder={t("vehicles.vehicleNamePlaceholder")} />
          {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
        </div>
        <div className="space-y-2">
          <Label>{t("vehicles.licensePlate")}</Label>
          <Input {...register("licensePlate")} placeholder={t("vehicles.licensePlatePlaceholder")} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("vehicles.vehicleType")}</Label>
        <Controller
          name="vehicleType"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} defaultValue={field.value}>
              <SelectTrigger>
                <SelectValue placeholder={t("vehicles.selectType")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fossil">{t("vehicles.fossilFuel")}</SelectItem>
                <SelectItem value="electric">{t("vehicles.electricEv")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("vehicles.weightCapacity")}</Label>
          <Input type="number" {...register("capacityKg")} />
        </div>
        <div className="space-y-2">
          <Label>{t("vehicles.volumeCapacity")}</Label>
          <Input type="number" {...register("capacityVolume")} />
        </div>
      </div>

      {isElectric && (
        <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2">
          <div className="space-y-2">
            <Label>{t("vehicles.batteryCapacity")}</Label>
            <Input type="number" {...register("batteryCapacityKwh")} />
          </div>
          <div className="space-y-2">
            <Label>{t("vehicles.maxRange")}</Label>
            <Input type="number" {...register("rangeKm")} />
          </div>
        </div>
      )}

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? t("common.saving") : t("vehicles.saveVehicle")}
        </Button>
      </div>
    </form>
  );
}
