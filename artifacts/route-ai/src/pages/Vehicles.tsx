import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles, useCreateVehicle, useUpdateVehicle, useDeleteVehicle, useReorderVehicles } from "@/hooks/use-vehicles";
import { useDrivers } from "@/hooks/use-drivers";
import { buildProfileByResourceId } from "@/lib/resources";
import { LoadingState } from "@/components/ui/LoadingState";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, Battery, Fuel, Truck, Clock, Weight, Box, X, Wrench, Copy, ArrowUp, ArrowDown } from "lucide-react";
import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResourcePhoneInput } from "@/components/ui/resource-phone-input";
import { normalizeResourcePhone } from "@/lib/resource-phone";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useAuth } from "@/lib/auth-context";
import { type AssignedDriverInput, type Driver, type UpdateVehicleBody, type Vehicle } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { getPersistedVerifiedAddress } from "@/lib/address-suggestions";

const ROUTE_COLOR_PRESETS = [
  "#2563EB", "#DC2626", "#059669", "#D97706", "#7C3AED",
  "#DB2777", "#0891B2", "#4F46E5", "#CA8A04", "#9333EA",
  "#EA580C", "#16A34A", "#0284C7", "#E11D48", "#475569",
] as const;

const createVehicleSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t("vehicles.nameRequired")),
  licensePlate: z.string().optional(),
  routeColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  vehicleType: z.enum(["fossil", "electric"]),
  capacityKg: z.coerce.number().min(0),
  capacityVolume: z.coerce.number().min(0),
  batteryCapacityKwh: z.coerce.number().optional().nullable(),
  rangeKm: z.coerce.number().optional().nullable(),
  equipmentInventory: z.string().optional(),
  driverPhone: z.string().optional(),
  driverEmail: z.string().email().optional().or(z.literal("")),
  driverWorkStartTime: z.string().optional(),
  driverWorkEndTime: z.string().optional(),
  driverBreakStartTime: z.string().optional(),
  driverBreakEndTime: z.string().optional(),
  driverStartAddress: z.string().optional(),
  driverEndAddress: z.string().optional(),
  driverSkills: z.string().optional(),
  driverTempo: z.enum(["slow", "normal", "fast"]).optional(),
});

type VehicleFormValues = z.infer<ReturnType<typeof createVehicleSchema>>;

export default function Vehicles() {
  const { data: vehicles, isLoading } = useVehicles();
  const { data: drivers } = useDrivers();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState<{ vehicle: Vehicle; driver?: Driver } | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const { t } = useTranslation();
  const { toast } = useToast();

  const deleteMutation = useDeleteVehicle();
  const reorderMutation = useReorderVehicles();

  // Internal operational profile per resource; dispatchers never pair these manually.
  const driverByVehicleId = useMemo(() => buildProfileByResourceId(vehicles, drivers), [vehicles, drivers]);

  const selectedVehicle = vehicles?.find((v) => v.id === selectedVehicleId);

  const moveVehicle = async (index: number, direction: -1 | 1) => {
    if (!vehicles) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= vehicles.length) return;
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);
    [vehicleIds[index], vehicleIds[targetIndex]] = [vehicleIds[targetIndex], vehicleIds[index]];
    try {
      await reorderMutation.mutateAsync({ data: { vehicleIds } });
    } catch {
      toast({ title: t("vehicles.reorderError"), variant: "destructive" });
    }
  };

  if (isLoading) return <AppLayout><LoadingState message={t("vehicles.loadingFleet")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div>
                <h1 className="text-2xl font-bold text-foreground">{t("vehicles.title")}</h1>
                <p className="text-muted-foreground text-sm mt-0.5">{t("vehicles.subtitle")}</p>
              </div>

              <Dialog
                open={isCreateOpen}
                onOpenChange={(open) => {
                  setIsCreateOpen(open);
                  if (!open) setDuplicateSource(null);
                }}
              >
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5 text-xs shrink-0">
                    <Plus className="h-3.5 w-3.5" /> {t("vehicles.addVehicle")}
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
                  <DialogHeader>
                    <DialogTitle>{duplicateSource ? t("vehicles.duplicateVehicle") : t("vehicles.addNewVehicle")}</DialogTitle>
                  </DialogHeader>
                  <VehicleForm
                    duplicateSource={duplicateSource ?? undefined}
                    onSuccess={() => {
                      setIsCreateOpen(false);
                      setDuplicateSource(null);
                    }}
                  />
                </DialogContent>
              </Dialog>
            </div>

            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <DualHorizontalScroll label={t("common.horizontalScroll")}>
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("common.vehicle")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">Arbetstid</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("common.type")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("vehicles.capacity")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("vehicles.rangeBattery")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs text-right sticky right-0 bg-muted z-10 shadow-[-1px_0_0_0_hsl(var(--border))]">{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {vehicles?.map((v, index) => (
                      <tr
                        key={v.id}
                        className={cn(
                          "group transition-colors cursor-pointer",
                          selectedVehicleId === v.id ? "bg-primary/5" : "hover:bg-muted/30"
                        )}
                        onClick={() => setSelectedVehicleId(selectedVehicleId === v.id ? null : v.id)}
                      >
                        <td className="p-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-sm text-foreground">{v.name}</p>
                            <span
                              className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/20 ring-offset-1 ring-offset-card"
                              style={{ backgroundColor: v.routeColor }}
                              title={`${t("vehicles.routeColor")}: ${v.routeColor}`}
                              aria-label={`${t("vehicles.routeColor")}: ${v.routeColor}`}
                            />
                          </div>
                          {v.licensePlate && <p className="text-[10px] text-muted-foreground mt-0.5 px-1.5 py-0.5 bg-muted inline-block rounded">{v.licensePlate}</p>}
                        </td>
                        <td className="p-3 text-xs whitespace-nowrap">
                          <ProfileHours profile={driverByVehicleId.get(v.id)} />
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            v.vehicleType === 'electric' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                          }`}>
                            {v.vehicleType === 'electric' ? <Battery className="h-3 w-3" /> : <Fuel className="h-3 w-3" />}
                            {v.vehicleType === 'electric' ? t("common.electric") : t("common.fossil")}
                          </div>
                        </td>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                          <span>{effectiveCapacity(v.capacityKg, driverByVehicleId.get(v.id)?.capacityKg)} kg · {effectiveCapacity(v.capacityVolume, driverByVehicleId.get(v.id)?.capacityVolume)} m³</span>
                        </td>
                        <td className="p-3 text-xs min-w-[120px]">
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
                        <td className={cn(
                          "px-3 py-1 text-right sticky right-0 z-10 shadow-[-1px_0_0_0_hsl(var(--border))]",
                          selectedVehicleId === v.id
                            ? "bg-blue-50 dark:bg-slate-800"
                            : "bg-card group-hover:bg-muted"
                        )}>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 shrink-0"
                              title={t("vehicles.moveUp")}
                              aria-label={`${t("vehicles.moveUp")}: ${v.name}`}
                              disabled={index === 0 || reorderMutation.isPending}
                              onClick={(event) => {
                                event.stopPropagation();
                                void moveVehicle(index, -1);
                              }}
                            >
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 shrink-0"
                              title={t("vehicles.moveDown")}
                              aria-label={`${t("vehicles.moveDown")}: ${v.name}`}
                              disabled={index === (vehicles?.length ?? 0) - 1 || reorderMutation.isPending}
                              onClick={(event) => {
                                event.stopPropagation();
                                void moveVehicle(index, 1);
                              }}
                            >
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                             <Button
                               variant="ghost"
                               size="icon"
                               className="h-11 w-11 shrink-0 hover:text-primary hover:bg-primary/10"
                               title={t("vehicles.duplicateVehicle")}
                               aria-label={t("vehicles.duplicateVehicle")}
                               onClick={(e) => {
                                 e.stopPropagation();
                                 setDuplicateSource({
                                   vehicle: v,
                                   driver: driverByVehicleId.get(v.id),
                                 });
                                 setIsCreateOpen(true);
                               }}
                             >
                               <Copy className="h-5 w-5" />
                             </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 shrink-0 hover:text-primary hover:bg-primary/10"
                              title={t("common.edit")}
                              aria-label={t("common.edit")}
                              onClick={(e) => { e.stopPropagation(); setEditingVehicle(v); }}
                            >
                              <Edit2 className="h-5 w-5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 shrink-0 hover:text-destructive hover:bg-destructive/10"
                              title={t("common.delete")}
                              aria-label={t("common.delete")}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!confirm(t("vehicles.deleteConfirm", { name: v.name }))) return;
                                deleteMutation.mutate(
                                  { id: v.id },
                                  {
                                    onSuccess: () => {
                                      setSelectedVehicleId((current) => current === v.id ? null : current);
                                      toast({ title: t("vehicles.deleteSuccess", { name: v.name }) });
                                    },
                                    onError: (error) => {
                                      const status = typeof error === "object" && error !== null && "status" in error
                                        ? Number(error.status)
                                        : null;
                                      toast({
                                        title: status === 409 ? t("vehicles.deleteBlocked") : t("vehicles.deleteError"),
                                        description: status === 409 ? t("vehicles.deleteBlockedDescription") : undefined,
                                        variant: "destructive",
                                      });
                                    },
                                  },
                                );
                              }}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className="h-5 w-5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {(!vehicles || vehicles.length === 0) && (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-muted-foreground">{t("vehicles.noVehicles")}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </DualHorizontalScroll>
            </div>


            <Dialog open={!!editingVehicle} onOpenChange={(open) => !open && setEditingVehicle(null)}>
              <DialogContent className="sm:max-w-[720px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{t("vehicles.editVehicle")}</DialogTitle>
                </DialogHeader>
                {editingVehicle && (
                  <VehicleForm
                    initialData={editingVehicle}
                    initialDriver={driverByVehicleId.get(editingVehicle.id)}
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
                <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label={t("common.close")} title={t("common.close")} onClick={() => setSelectedVehicleId(null)}>
                  <X className="h-5 w-5" />
                </Button>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 border border-border">
                  <Truck className="h-8 w-8 text-primary" />
                  <div>
                    <p className="font-semibold text-sm">{selectedVehicle.licensePlate || "Ingen registreringsskylt"}</p>
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
                    value={`${effectiveCapacity(selectedVehicle.capacityKg, driverByVehicleId.get(selectedVehicle.id)?.capacityKg)} kg`}
                  />
                  <DetailCard
                    icon={<Box className="h-4 w-4 text-violet-400" />}
                    label={t("common.volume")}
                    value={`${effectiveCapacity(selectedVehicle.capacityVolume, driverByVehicleId.get(selectedVehicle.id)?.capacityVolume)} m³`}
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

                <div className="p-3 rounded-xl bg-cyan-500/5 border border-cyan-500/20 space-y-2">
                  <div className="flex items-center gap-2">
                    <Wrench className="h-4 w-4 text-cyan-400" />
                    <p className="text-xs font-medium text-cyan-400">{t("vehicles.equipmentInventory")}</p>
                  </div>
                  {selectedVehicle.equipmentInventory?.length ? (
                    <div className="flex flex-wrap gap-1.5" data-testid="vehicle-equipment-list">
                      {selectedVehicle.equipmentInventory.map((item) => (
                        <span key={item} className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[10px] font-medium text-cyan-300">
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("vehicles.noEquipment")}</p>
                  )}
                </div>

                {driverByVehicleId.has(selectedVehicle.id) && (() => {
                  const driver = driverByVehicleId.get(selectedVehicle.id)!;
                  return (
                    <div className="p-3 rounded-xl bg-violet-500/5 border border-violet-500/20 space-y-1">
                      <p className="text-xs font-medium text-violet-400">Driftprofil</p>
                      <ProfileHours profile={driver} />
                      {driver.phone && <p className="text-[10px] text-muted-foreground">{driver.phone}</p>}
                      {driver.email && <p className="text-[10px] text-muted-foreground">{driver.email}</p>}
                      {driver.startAddress && <p className="text-[10px] text-muted-foreground">Start: {driver.startAddress}</p>}
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

function effectiveCapacity(resource: number, profile?: number | null): number {
  return profile != null && profile < resource ? profile : resource;
}

function ProfileHours({ profile }: { profile?: Driver }) {
  if (!profile) return <span className="text-xs text-amber-600" data-testid="text-profile-missing">Driftprofil behöver granskas</span>;
  const hours = profile.workStartTime && profile.workEndTime
    ? `${profile.workStartTime.slice(0, 5)}–${profile.workEndTime.slice(0, 5)}`
    : "Arbetstid saknas";
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
      <Clock className="h-3 w-3" />{hours}
    </span>
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

function TechSection({ enabled, title, children }: { enabled: boolean; title: string; children: React.ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <details className="group rounded-lg border border-border bg-muted/10">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">{title}</summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  );
}

export function VehicleForm({
  initialData,
  initialDriver,
  duplicateSource,
  onSuccess,
  variant = "vehicle",
}: {
  variant?: "vehicle" | "driver";
  initialData?: Vehicle;
  initialDriver?: Driver;
  duplicateSource?: { vehicle: Vehicle; driver?: Driver };
  onSuccess: () => void;
}) {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const createMutation = useCreateVehicle();
  const updateMutation = useUpdateVehicle();
  const { t } = useTranslation();
  const { toast } = useToast();
  const persistedDriver = initialDriver ?? duplicateSource?.driver;
  const persistedStartAddress = getPersistedVerifiedAddress(
    persistedDriver?.startAddress,
    persistedDriver?.startLatitude,
    persistedDriver?.startLongitude,
  );
  const persistedEndAddress = getPersistedVerifiedAddress(
    persistedDriver?.endAddress,
    persistedDriver?.endLatitude,
    persistedDriver?.endLongitude,
  );

  const { register, handleSubmit, watch, control, setValue, setError, formState: { errors } } = useForm<z.input<ReturnType<typeof createVehicleSchema>>, unknown, VehicleFormValues>({
    resolver: zodResolver(createVehicleSchema(t)),
    defaultValues: initialData ? {
      ...initialData,
      licensePlate: initialData.licensePlate ?? "",
      // One visible capacity per dimension: legacy effective limit is the stricter of resource and profile.
      capacityKg: effectiveCapacity(initialData.capacityKg, initialDriver?.capacityKg),
      capacityVolume: effectiveCapacity(initialData.capacityVolume, initialDriver?.capacityVolume),
      equipmentInventory: initialData.equipmentInventory?.join(", ") ?? "",
      driverPhone: initialDriver?.phone ?? "",
      driverEmail: initialDriver?.email ?? "",
      driverWorkStartTime: initialDriver?.workStartTime ?? "",
      driverWorkEndTime: initialDriver?.workEndTime ?? "",
      driverBreakStartTime: initialDriver?.breakStartTime ?? "",
      driverBreakEndTime: initialDriver?.breakEndTime ?? "",
      driverStartAddress: initialDriver?.startAddress ?? "",
      driverEndAddress: initialDriver?.endAddress ?? "",
      driverSkills: initialDriver?.skills?.join(", ") ?? "",
      driverTempo: initialDriver?.tempo ?? "normal",
    } : duplicateSource ? {
      name: `${duplicateSource.vehicle.name} (${t("vehicles.copySuffix")})`,
      licensePlate: "",
      routeColor: duplicateSource.vehicle.routeColor,
      vehicleType: duplicateSource.vehicle.vehicleType,
      capacityKg: effectiveCapacity(duplicateSource.vehicle.capacityKg, duplicateSource.driver?.capacityKg),
      capacityVolume: effectiveCapacity(duplicateSource.vehicle.capacityVolume, duplicateSource.driver?.capacityVolume),
      batteryCapacityKwh: duplicateSource.vehicle.batteryCapacityKwh,
      rangeKm: duplicateSource.vehicle.rangeKm,
      equipmentInventory: duplicateSource.vehicle.equipmentInventory?.join(", ") ?? "",
      driverPhone: duplicateSource.driver?.phone ?? "",
      driverEmail: duplicateSource.driver?.email ?? "",
      driverWorkStartTime: duplicateSource.driver?.workStartTime ?? "",
      driverWorkEndTime: duplicateSource.driver?.workEndTime ?? "",
      driverBreakStartTime: duplicateSource.driver?.breakStartTime ?? "",
      driverBreakEndTime: duplicateSource.driver?.breakEndTime ?? "",
      driverStartAddress: duplicateSource.driver?.startAddress ?? "",
      driverEndAddress: duplicateSource.driver?.endAddress ?? "",
      driverSkills: duplicateSource.driver?.skills?.join(", ") ?? "",
      driverTempo: duplicateSource.driver?.tempo ?? "normal",
    } : {
      vehicleType: "fossil",
      routeColor: "#2563EB",
      capacityKg: 1000,
      capacityVolume: 10,
      equipmentInventory: "",
      driverTempo: "normal",
    }
  });

  const isDriver = variant === "driver";
  const isElectric = watch("vehicleType") === "electric";
  const selectedRouteColor = watch("routeColor");
  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = async (data: VehicleFormValues) => {
    const equipmentInventory = data.equipmentInventory
      ? data.equipmentInventory.split(",").map((item) => item.trim()).filter(Boolean)
      : null;
    const {
      driverPhone, driverEmail, driverWorkStartTime, driverWorkEndTime,
      driverBreakStartTime, driverBreakEndTime,
      driverStartAddress, driverEndAddress, driverSkills, driverTempo,
      ...vehicleFields
    } = data;
    const payload = {
      ...vehicleFields,
      licensePlate: data.licensePlate?.trim() ?? "",
      routeColor: data.routeColor.toUpperCase(),
      equipmentInventory,
    };
    if (!organizationId) return;
    // Operational profile always carries the resource name; no separate driver identity.
    const driver: AssignedDriverInput = {
      name: data.name.trim(),
      phone: driverPhone ? normalizeResourcePhone(driverPhone) || null : null,
      email: driverEmail?.trim() || null,
      workStartTime: driverWorkStartTime || null,
      workEndTime: driverWorkEndTime || null,
      breakStartTime: driverBreakStartTime || null,
      breakEndTime: driverBreakEndTime || null,
      capacityKg: vehicleFields.capacityKg,
      capacityVolume: vehicleFields.capacityVolume,
      startAddress: driverStartAddress?.trim() || null,
      endAddress: driverEndAddress?.trim() || null,
      skills: driverSkills
        ? driverSkills.split(",").map((item) => item.trim()).filter(Boolean)
        : null,
      tempo: driverTempo ?? "normal",
      driverRole: "driver" as const,
    };
    try {
      if (initialData) {
        // Single atomic write: resource fields and nested profile together.
        const data: UpdateVehicleBody = { ...payload, driver };
        await updateMutation.mutateAsync({ id: initialData.id, data });
        onSuccess();
      } else {
        await createMutation.mutateAsync({ data: { ...payload, driver, organizationId } });
        onSuccess();
      }
    } catch (error) {
      const responseData = error && typeof error === "object" && "data" in error
        ? (error as { data?: unknown }).data
        : null;
      const serverMessage = responseData && typeof responseData === "object" && "error" in responseData
        ? (responseData as { error?: unknown }).error
        : null;
      const addressField = serverMessage === "Chaufförens startplats kunde inte verifieras"
        ? "driverStartAddress"
        : serverMessage === "Chaufförens slutplats kunde inte verifieras" ? "driverEndAddress" : null;
      const generalAddressError = serverMessage === "Resursens start- eller slutplats kunde inte verifieras";
      if (addressField) {
        setError(addressField, { type: "server", message: t("drivers.addressNotVerified") });
      } else if (generalAddressError) {
        setError("driverStartAddress", { type: "server", message: "Start- eller slutplats kunde inte verifieras" });
        setError("driverEndAddress", { type: "server", message: "Start- eller slutplats kunde inte verifieras" });
      }
      toast({
        title: t("vehicles.saveError"),
        description: addressField || generalAddressError ? t("drivers.addressNotVerified") : typeof serverMessage === "string" ? serverMessage : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={cn("pt-4", isDriver ? "flex flex-col gap-4" : "space-y-4")}>
      <p className="text-xs text-muted-foreground"><span className="text-destructive">*</span> Obligatoriska fält. Övriga fält är valfria.</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="resource-name">{isDriver ? "Namn" : "Resursnamn"} <span className="text-destructive">*</span></Label>
          <Input id="resource-name" required aria-required="true" {...register("name")} placeholder="ABC123, Anders eller Bil1 Anders" data-testid="input-resource-name" />
          {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
        </div>
        <div className="space-y-2">
          <Label>{t("vehicles.licensePlate")} <span className="text-xs text-muted-foreground">(valfritt)</span></Label>
          <Input {...register("licensePlate")} placeholder={t("vehicles.licensePlatePlaceholder")} />
        </div>
      </div>

      <TechSection enabled={isDriver} title="Fordonsdetaljer (ruttfärg, fordonstyp)">
      <div className="space-y-2">
        <Label htmlFor="vehicle-route-color">{t("vehicles.routeColor")} <span className="text-destructive">*</span></Label>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("vehicles.routeColorPresets")}>
          {ROUTE_COLOR_PRESETS.map((color) => {
            const isSelected = selectedRouteColor?.toUpperCase() === color;
            return (
              <button
                key={color}
                type="button"
                className={cn(
                  "h-7 w-7 rounded-full border-2 border-background shadow-sm ring-1 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  isSelected ? "scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background" : "ring-black/20",
                )}
                style={{ backgroundColor: color }}
                onClick={() => setValue("routeColor", color, { shouldDirty: true, shouldValidate: true })}
                aria-label={`${t("vehicles.selectRouteColor")} ${color}`}
                aria-pressed={isSelected}
                title={color}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Controller
            name="routeColor"
            control={control}
            render={({ field }) => (
              <>
                <Input
                  id="vehicle-route-color"
                  type="color"
                  aria-required="true"
                  value={field.value}
                   onInput={(event) => field.onChange(event.currentTarget.value.toUpperCase())}
                   onChange={(event) => field.onChange(event.currentTarget.value.toUpperCase())}
                   onBlur={field.onBlur}
                   name={field.name}
                   ref={field.ref}
                  className="h-11 w-16 cursor-pointer p-1"
                  aria-label={t("vehicles.routeColor")}
                />
                <Input
                  value={field.value}
                  onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                  className="w-32 font-mono uppercase"
                  maxLength={7}
                  aria-label={t("vehicles.routeColorHex")}
                />
              </>
            )}
          />
          <span
            className="h-8 flex-1 rounded-md border"
            style={{ backgroundColor: selectedRouteColor }}
            aria-hidden="true"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("vehicles.routeColorHelp")}</p>
        {errors.routeColor && <span className="text-xs text-destructive">{t("vehicles.routeColorInvalid")}</span>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-vehicle-type">{t("vehicles.vehicleType")} <span className="text-destructive">*</span></Label>
        <Controller
          name="vehicleType"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} defaultValue={field.value}>
              <SelectTrigger id="resource-vehicle-type" aria-required="true">
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
      </TechSection>

      <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
          <div>
            <h3 className="font-semibold">{isDriver ? "Förare och arbetsdag" : "Driftprofil"}</h3>
            <p className="text-xs text-muted-foreground">Arbetstid, startplats och kompetenser för resursen. Kontaktuppgifter är valfria.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
               <Label htmlFor="resource-phone">{t("drivers.phone")} <span className="text-xs text-muted-foreground">(valfritt)</span></Label>
              <Controller name="driverPhone" control={control} render={({ field }) => (
                <ResourcePhoneInput id="resource-phone" name={field.name} value={field.value ?? ""} onChange={field.onChange} onBlur={field.onBlur} inputRef={field.ref} />
              )} />
               {errors.driverPhone && <span className="text-xs text-destructive">{errors.driverPhone.message}</span>}
            </div>
            <div className="space-y-2">
              <Label>{t("drivers.email")}</Label>
              <Input type="email" {...register("driverEmail")} placeholder="chauffor@example.com" />
            </div>
            <div className="space-y-2">
              <Label>{t("drivers.tempo")}</Label>
              <Controller
                name="driverTempo"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="slow">{t("drivers.tempoSlow")}</SelectItem>
                      <SelectItem value="normal">{t("drivers.tempoNormal")}</SelectItem>
                      <SelectItem value="fast">{t("drivers.tempoFast")}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="space-y-2"><Label>{isDriver ? "Arbetstid från" : t("drivers.workStart")}</Label><Input type="time" {...register("driverWorkStartTime")} /></div>
            <div className="space-y-2"><Label>{isDriver ? "Arbetstid till" : t("drivers.workEnd")}</Label><Input type="time" {...register("driverWorkEndTime")} /></div>
            <div className="space-y-2"><Label>{isDriver ? "Lunchrast från" : t("drivers.breakStart")}</Label><Input type="time" {...register("driverBreakStartTime")} /></div>
            <div className="space-y-2"><Label>{isDriver ? "Lunchrast till" : t("drivers.breakEnd")}</Label><Input type="time" {...register("driverBreakEndTime")} /></div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
             <div className="space-y-2">
               <Label>{isDriver ? "Startadress" : t("drivers.startLocation")}</Label>
               <Controller
                 name="driverStartAddress"
                 control={control}
                  render={({ field }) => (
                    <AddressAutocomplete
                      {...field}
                      placeholder={t("drivers.addressPlaceholder")}
                      persistedVerifiedAddress={persistedStartAddress}
                    />
                  )}
               />
               {errors.driverStartAddress && <span className="text-xs text-destructive">{errors.driverStartAddress.message}</span>}
             </div>
             <div className="space-y-2">
               <Label>{isDriver ? "Slutadress" : t("drivers.endLocation")}</Label>
               <Controller
                 name="driverEndAddress"
                 control={control}
                  render={({ field }) => (
                    <AddressAutocomplete
                      {...field}
                      placeholder={t("drivers.addressPlaceholder")}
                      persistedVerifiedAddress={persistedEndAddress}
                    />
                  )}
               />
               {errors.driverEndAddress && <span role="alert" className="text-xs text-destructive">{errors.driverEndAddress.message}</span>}
             </div>
          </div>
          <div className="space-y-2">
            <Label>{t("drivers.skills")}</Label>
            <Input {...register("driverSkills")} placeholder={t("vehicles.driverSkillsPlaceholder")} />
          </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="resource-capacity-kg">{t("vehicles.weightCapacity")} <span className="text-destructive">*</span></Label>
          <Input id="resource-capacity-kg" required aria-required="true" min={0} type="number" {...register("capacityKg")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="resource-capacity-volume">{t("vehicles.volumeCapacity")} <span className="text-destructive">*</span></Label>
          <Input id="resource-capacity-volume" required aria-required="true" min={0} step="any" type="number" {...register("capacityVolume")} />
        </div>
      </div>

      <TechSection enabled={isDriver} title="Batteri och utrustning">
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

      <div className="space-y-2">
        <Label>{t("vehicles.equipmentInventory")}</Label>
        <Input
          {...register("equipmentInventory")}
          placeholder={t("vehicles.equipmentInventoryPlaceholder")}
          data-testid="input-vehicle-equipment"
        />
        <p className="text-xs text-muted-foreground">{t("vehicles.equipmentInventoryHelp")}</p>
      </div>
      </TechSection>

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? t("common.saving") : isDriver ? "Spara förare" : t("vehicles.saveVehicle")}
        </Button>
      </div>
    </form>
  );
}
