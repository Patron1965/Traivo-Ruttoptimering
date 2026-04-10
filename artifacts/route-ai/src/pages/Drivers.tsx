import { AppLayout } from "@/components/layout/AppLayout";
import { useDrivers, useCreateDriver, useUpdateDriver, useDeleteDriver } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, User, Phone, Mail, Truck, ToggleLeft, BarChart3, X, Clock, Gauge, Package, MapPin } from "lucide-react";
import { Link } from "wouter";
import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ORG_ID } from "@/lib/constants";
import { type Driver } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const driverSchema = z.object({
  name: z.string().min(1, "Name is required"),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal("")).nullable(),
  vehicleId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  workStartTime: z.string().optional().nullable(),
  workEndTime: z.string().optional().nullable(),
  tempo: z.string().optional().nullable(),
  capacityKg: z.coerce.number().optional().nullable(),
  capacityVolume: z.coerce.number().optional().nullable(),
  startAddress: z.string().optional().nullable(),
  startLatitude: z.coerce.number().optional().nullable(),
  startLongitude: z.coerce.number().optional().nullable(),
  endAddress: z.string().optional().nullable(),
  endLatitude: z.coerce.number().optional().nullable(),
  endLongitude: z.coerce.number().optional().nullable(),
});

type DriverFormValues = z.infer<typeof driverSchema>;

export default function Drivers() {
  const { data: drivers, isLoading } = useDrivers();
  const { data: vehicles } = useVehicles();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const deleteMutation = useDeleteDriver();
  const { t } = useTranslation();

  const selectedDriver = drivers?.find((d) => d.id === selectedDriverId);

  if (isLoading) return <AppLayout><LoadingState message={t("drivers.loadingDrivers")} /></AppLayout>;

  const getVehicleName = (vehicleId: string | null | undefined) => {
    if (!vehicleId || !vehicles) return null;
    const v = vehicles.find((v) => v.id === vehicleId);
    return v ? `${v.name} (${v.licensePlate})` : null;
  };

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold text-foreground">{t("drivers.title")}</h1>
                <p className="text-muted-foreground text-sm mt-0.5">{t("drivers.subtitle")}</p>
              </div>

              <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5 text-xs">
                    <Plus className="h-3.5 w-3.5" /> {t("drivers.addDriver")}
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[500px]">
                  <DialogHeader>
                    <DialogTitle>{t("drivers.addNewDriver")}</DialogTitle>
                  </DialogHeader>
                  <DriverForm vehicles={vehicles || []} onSuccess={() => setIsCreateOpen(false)} />
                </DialogContent>
              </Dialog>
            </div>

            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("drivers.driver")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("drivers.contact")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("drivers.assignedVehicle")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs">{t("common.status")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs text-right">{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {drivers?.map((d) => (
                      <tr
                        key={d.id}
                        className={cn(
                          "transition-colors cursor-pointer",
                          selectedDriverId === d.id ? "bg-primary/5" : "hover:bg-muted/30"
                        )}
                        onClick={() => setSelectedDriverId(selectedDriverId === d.id ? null : d.id)}
                      >
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                              <User className="h-4 w-4 text-primary" />
                            </div>
                            <Link
                              href={`/drivers/${d.id}`}
                              className="font-bold text-sm text-foreground hover:text-primary transition-colors"
                              onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            >
                              {d.name}
                            </Link>
                          </div>
                        </td>
                        <td className="p-3 text-xs">
                          <div className="space-y-0.5">
                            {d.phone && (
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <Phone className="h-3 w-3" />
                                {d.phone}
                              </div>
                            )}
                            {d.email && (
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <Mail className="h-3 w-3" />
                                {d.email}
                              </div>
                            )}
                            {!d.phone && !d.email && (
                              <span className="text-muted-foreground italic">{t("drivers.noContactInfo")}</span>
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          {d.vehicleId ? (
                            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary">
                              <Truck className="h-3 w-3" />
                              {getVehicleName(d.vehicleId) || "Unknown"}
                            </div>
                          ) : (
                            <span className="text-muted-foreground italic text-xs">{t("common.unassigned")}</span>
                          )}
                        </td>
                        <td className="p-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            d.isActive
                              ? "bg-emerald-500/10 text-emerald-500"
                              : "bg-muted text-muted-foreground"
                          }`}>
                            {d.isActive ? t("drivers.active") : t("drivers.inactive")}
                          </span>
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 hover:text-primary hover:bg-primary/10"
                              onClick={(e) => { e.stopPropagation(); setEditingDriver(d); }}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 hover:text-destructive hover:bg-destructive/10"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(t("drivers.deleteConfirm"))) deleteMutation.mutate({ id: d.id, params: { organizationId: ORG_ID } });
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {(!drivers || drivers.length === 0) && (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-muted-foreground">{t("drivers.noDrivers")}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <Dialog open={!!editingDriver} onOpenChange={(open) => !open && setEditingDriver(null)}>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                  <DialogTitle>{t("drivers.editDriver")}</DialogTitle>
                </DialogHeader>
                {editingDriver && (
                  <DriverForm
                    initialData={editingDriver}
                    vehicles={vehicles || []}
                    onSuccess={() => setEditingDriver(null)}
                  />
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className={cn(
          "shrink-0 border-l border-border bg-card overflow-y-auto transition-all duration-200",
          selectedDriver ? "w-[380px]" : "w-0"
        )}>
          {selectedDriver && (
            <div className="p-5 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-lg">{selectedDriver.name}</h2>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedDriverId(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/30 border border-border">
                  <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <User className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold">{selectedDriver.name}</p>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold mt-1 ${
                      selectedDriver.isActive
                        ? "bg-emerald-500/10 text-emerald-500"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {selectedDriver.isActive ? t("drivers.active") : t("drivers.inactive")}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("drivers.contact")}</p>
                  {selectedDriver.phone && (
                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/20 border border-border">
                      <Phone className="h-4 w-4 text-blue-400" />
                      <span className="text-sm">{selectedDriver.phone}</span>
                    </div>
                  )}
                  {selectedDriver.email && (
                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/20 border border-border">
                      <Mail className="h-4 w-4 text-emerald-400" />
                      <span className="text-sm">{selectedDriver.email}</span>
                    </div>
                  )}
                  {!selectedDriver.phone && !selectedDriver.email && (
                    <p className="text-xs text-muted-foreground italic">{t("drivers.noContactInfo")}</p>
                  )}
                </div>

                {selectedDriver.vehicleId && (
                  <div className="p-3 rounded-xl bg-blue-500/5 border border-blue-500/20 space-y-1">
                    <p className="text-xs font-medium text-blue-400">{t("drivers.assignedVehicle")}</p>
                    <div className="flex items-center gap-2">
                      <Truck className="h-5 w-5 text-blue-400" />
                      <p className="text-sm font-semibold">{getVehicleName(selectedDriver.vehicleId)}</p>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5 text-xs"
                    onClick={() => setEditingDriver(selectedDriver)}
                  >
                    <Edit2 className="h-3 w-3" />
                    {t("common.edit") || "Redigera"}
                  </Button>
                  <Link href={`/drivers/${selectedDriver.id}`} className="flex-1">
                    <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs">
                      <BarChart3 className="h-3 w-3" />
                      {t("drivers.viewStats") || "Statistik"}
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function DriverForm({ initialData, vehicles, onSuccess }: {
  initialData?: Driver;
  vehicles: Array<{ id: string; name: string; licensePlate: string }>;
  onSuccess: () => void;
}) {
  const createMutation = useCreateDriver();
  const updateMutation = useUpdateDriver();
  const { t } = useTranslation();

  const { register, handleSubmit, control, formState: { errors } } = useForm<DriverFormValues>({
    resolver: zodResolver(driverSchema),
    defaultValues: initialData || {},
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = (data: DriverFormValues) => {
    const payload = {
      ...data,
      vehicleId: data.vehicleId === "__none__" ? null : (data.vehicleId || null),
      email: data.email || null,
      phone: data.phone || null,
      isActive: data.isActive ?? true,
      tempo: data.tempo === "__none__" ? null : (data.tempo || null),
    };
    if (initialData) {
      updateMutation.mutate({ id: initialData.id, data: payload, params: { organizationId: ORG_ID } }, { onSuccess });
    } else {
      createMutation.mutate({ data: { ...payload, organizationId: ORG_ID } }, { onSuccess });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4 max-h-[70vh] overflow-y-auto pr-2">
      <div className="space-y-2">
        <Label>{t("drivers.fullName")}</Label>
        <Input {...register("name")} placeholder={t("drivers.namePlaceholder")} />
        {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("drivers.phone")}</Label>
          <Input {...register("phone")} placeholder="+46 70 123 4567" />
        </div>
        <div className="space-y-2">
          <Label>{t("drivers.email")}</Label>
          <Input {...register("email")} placeholder="erik@example.com" type="email" />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("drivers.assignedVehicle")}</Label>
        <Controller
          name="vehicleId"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} defaultValue={field.value || "__none__"}>
              <SelectTrigger>
                <SelectValue placeholder={t("drivers.selectVehicle")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("drivers.noVehicle")}</SelectItem>
                {vehicles.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name} ({v.licensePlate})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" /> {t("drivers.workHours")}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t("drivers.workStart")}</Label>
            <Input type="time" {...register("workStartTime")} />
          </div>
          <div className="space-y-2">
            <Label>{t("drivers.workEnd")}</Label>
            <Input type="time" {...register("workEndTime")} />
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Gauge className="h-3.5 w-3.5" /> {t("drivers.drivingProfile")}
        </p>
        <div className="space-y-2">
          <Label>{t("drivers.tempo")}</Label>
          <Controller
            name="tempo"
            control={control}
            render={({ field }) => (
              <Select onValueChange={field.onChange} defaultValue={field.value || "normal"}>
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

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" /> {t("drivers.capacity")}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t("drivers.capacityKg")}</Label>
            <Input type="number" step="0.1" {...register("capacityKg")} placeholder="0" />
          </div>
          <div className="space-y-2">
            <Label>{t("drivers.capacityVolume")}</Label>
            <Input type="number" step="0.1" {...register("capacityVolume")} placeholder="0" />
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5" /> {t("drivers.startLocation")}
        </p>
        <div className="space-y-2">
          <Input {...register("startAddress")} placeholder={t("drivers.addressPlaceholder")} />
          <div className="grid grid-cols-2 gap-4">
            <Input type="number" step="any" {...register("startLatitude")} placeholder={t("drivers.latitude")} />
            <Input type="number" step="any" {...register("startLongitude")} placeholder={t("drivers.longitude")} />
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5" /> {t("drivers.endLocation")}
        </p>
        <div className="space-y-2">
          <Input {...register("endAddress")} placeholder={t("drivers.addressPlaceholder")} />
          <div className="grid grid-cols-2 gap-4">
            <Input type="number" step="any" {...register("endLatitude")} placeholder={t("drivers.latitude")} />
            <Input type="number" step="any" {...register("endLongitude")} placeholder={t("drivers.longitude")} />
          </div>
        </div>
      </div>

      {initialData && (
        <div className="flex items-center justify-between p-3 rounded-lg border border-border">
          <div>
            <Label>{t("common.status")}</Label>
            <p className="text-xs text-muted-foreground">{t("drivers.statusDescription")}</p>
          </div>
          <Controller
            name="isActive"
            control={control}
            render={({ field }) => (
              <Checkbox
                checked={field.value ?? true}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </div>
      )}

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? t("common.saving") : t("drivers.saveDriver")}
        </Button>
      </div>
    </form>
  );
}
