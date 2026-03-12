import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles, useCreateVehicle, useUpdateVehicle, useDeleteVehicle } from "@/hooks/use-vehicles";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, Battery, Fuel } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ORG_ID } from "@/lib/constants";
import { type Vehicle } from "@workspace/api-client-react";

const vehicleSchema = z.object({
  name: z.string().min(1, "Name is required"),
  licensePlate: z.string().min(1, "License plate is required"),
  vehicleType: z.enum(["fossil", "electric"]),
  capacityKg: z.coerce.number().min(0),
  capacityVolume: z.coerce.number().min(0),
  batteryCapacityKwh: z.coerce.number().optional().nullable(),
  rangeKm: z.coerce.number().optional().nullable(),
});

type VehicleFormValues = z.infer<typeof vehicleSchema>;

export default function Vehicles() {
  const { data: vehicles, isLoading } = useVehicles();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);

  const deleteMutation = useDeleteVehicle();

  if (isLoading) return <AppLayout><LoadingState message="Loading fleet data..." /></AppLayout>;

  return (
    <AppLayout>
      <div className="p-6 md:p-8 max-w-7xl mx-auto animate-in fade-in">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Fleet Management</h1>
            <p className="text-muted-foreground mt-1">Manage your vehicles and capacities</p>
          </div>
          
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg hover:shadow-primary/25">
                <Plus className="h-4 w-4" /> Add Vehicle
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Add New Vehicle</DialogTitle>
              </DialogHeader>
              <VehicleForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card rounded-2xl border border-card-border overflow-hidden shadow-xl shadow-black/5">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Vehicle</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Type</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Capacity</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Range/Battery</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {vehicles?.map((v) => (
                  <tr key={v.id} className="hover:bg-muted/30 transition-colors">
                    <td className="p-4">
                      <p className="font-bold text-foreground">{v.name}</p>
                      <p className="text-xs text-muted-foreground mt-1 px-2 py-0.5 bg-muted inline-block rounded">{v.licensePlate}</p>
                    </td>
                    <td className="p-4">
                      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                        v.vehicleType === 'electric' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                      }`}>
                        {v.vehicleType === 'electric' ? <Battery className="h-3 w-3" /> : <Fuel className="h-3 w-3" />}
                        {v.vehicleType.charAt(0).toUpperCase() + v.vehicleType.slice(1)}
                      </div>
                    </td>
                    <td className="p-4 text-sm">
                      <div className="space-y-1">
                        <p><span className="text-muted-foreground">Weight:</span> {v.capacityKg} kg</p>
                        <p><span className="text-muted-foreground">Volume:</span> {v.capacityVolume} m³</p>
                      </div>
                    </td>
                    <td className="p-4 text-sm">
                      {v.vehicleType === 'electric' ? (
                         <div className="space-y-2">
                           <div className="flex items-center gap-2">
                             <div className="w-24 h-3 bg-muted rounded-full overflow-hidden">
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
                             <span className="text-xs font-semibold">{v.currentBatteryPercent ?? 0}%</span>
                           </div>
                           <p className="text-xs text-muted-foreground">
                             {v.rangeKm ? `${Math.round((v.rangeKm * (v.currentBatteryPercent ?? 100)) / 100)} km remaining` : ''} · {v.batteryCapacityKwh} kWh
                           </p>
                         </div>
                      ) : <span className="text-muted-foreground italic">N/A</span>}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="hover:text-primary hover:bg-primary/10"
                          onClick={() => setEditingVehicle(v)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="hover:text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            if(confirm("Delete this vehicle?")) deleteMutation.mutate({ id: v.id });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {(!vehicles || vehicles.length === 0) && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">No vehicles found. Add one to get started.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Edit Modal */}
        <Dialog open={!!editingVehicle} onOpenChange={(open) => !open && setEditingVehicle(null)}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Edit Vehicle</DialogTitle>
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
    </AppLayout>
  );
}

function VehicleForm({ initialData, onSuccess }: { initialData?: Vehicle, onSuccess: () => void }) {
  const createMutation = useCreateVehicle();
  const updateMutation = useUpdateVehicle();
  
  const { register, handleSubmit, watch, control, formState: { errors } } = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
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
          <Label>Vehicle Name</Label>
          <Input {...register("name")} placeholder="e.g. Delivery Van 1" />
          {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
        </div>
        <div className="space-y-2">
          <Label>License Plate</Label>
          <Input {...register("licensePlate")} placeholder="ABC 123" />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Vehicle Type</Label>
        <Controller
          name="vehicleType"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} defaultValue={field.value}>
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fossil">Fossil Fuel (ICE)</SelectItem>
                <SelectItem value="electric">Electric (EV)</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Weight Capacity (kg)</Label>
          <Input type="number" {...register("capacityKg")} />
        </div>
        <div className="space-y-2">
          <Label>Volume Capacity (m³)</Label>
          <Input type="number" {...register("capacityVolume")} />
        </div>
      </div>

      {isElectric && (
        <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2">
          <div className="space-y-2">
            <Label>Battery Capacity (kWh)</Label>
            <Input type="number" {...register("batteryCapacityKwh")} />
          </div>
          <div className="space-y-2">
            <Label>Max Range (km)</Label>
            <Input type="number" {...register("rangeKm")} />
          </div>
        </div>
      )}

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>Cancel</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? "Saving..." : "Save Vehicle"}
        </Button>
      </div>
    </form>
  );
}
