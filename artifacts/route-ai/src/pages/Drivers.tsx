import { AppLayout } from "@/components/layout/AppLayout";
import { useDrivers, useCreateDriver, useUpdateDriver, useDeleteDriver } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, User, Phone, Mail, Truck } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ORG_ID } from "@/lib/constants";
import { type Driver } from "@workspace/api-client-react";

const driverSchema = z.object({
  name: z.string().min(1, "Name is required"),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal("")).nullable(),
  vehicleId: z.string().optional().nullable(),
});

type DriverFormValues = z.infer<typeof driverSchema>;

export default function Drivers() {
  const { data: drivers, isLoading } = useDrivers();
  const { data: vehicles } = useVehicles();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null);
  const deleteMutation = useDeleteDriver();

  if (isLoading) return <AppLayout><LoadingState message="Loading drivers..." /></AppLayout>;

  const getVehicleName = (vehicleId: string | null | undefined) => {
    if (!vehicleId || !vehicles) return null;
    const v = vehicles.find((v) => v.id === vehicleId);
    return v ? `${v.name} (${v.licensePlate})` : null;
  };

  return (
    <AppLayout>
      <div className="p-6 md:p-8 max-w-7xl mx-auto animate-in fade-in">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Driver Management</h1>
            <p className="text-muted-foreground mt-1">Manage drivers and vehicle assignments</p>
          </div>

          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg hover:shadow-primary/25">
                <Plus className="h-4 w-4" /> Add Driver
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Add New Driver</DialogTitle>
              </DialogHeader>
              <DriverForm vehicles={vehicles || []} onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card rounded-2xl border border-card-border overflow-hidden shadow-xl shadow-black/5">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Driver</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Contact</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Assigned Vehicle</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Status</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {drivers?.map((d) => (
                  <tr key={d.id} className="hover:bg-muted/30 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="h-5 w-5 text-primary" />
                        </div>
                        <p className="font-bold text-foreground">{d.name}</p>
                      </div>
                    </td>
                    <td className="p-4 text-sm">
                      <div className="space-y-1">
                        {d.phone && (
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <Phone className="h-3 w-3" />
                            {d.phone}
                          </div>
                        )}
                        {d.email && (
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <Mail className="h-3 w-3" />
                            {d.email}
                          </div>
                        )}
                        {!d.phone && !d.email && (
                          <span className="text-muted-foreground italic">No contact info</span>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      {d.vehicleId ? (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary">
                          <Truck className="h-3 w-3" />
                          {getVehicleName(d.vehicleId) || "Unknown"}
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic text-sm">Unassigned</span>
                      )}
                    </td>
                    <td className="p-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                        d.isActive
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {d.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="hover:text-primary hover:bg-primary/10"
                          onClick={() => setEditingDriver(d)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="hover:text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            if (confirm("Delete this driver?")) deleteMutation.mutate({ id: d.id });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {(!drivers || drivers.length === 0) && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">No drivers found. Add one to get started.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <Dialog open={!!editingDriver} onOpenChange={(open) => !open && setEditingDriver(null)}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Edit Driver</DialogTitle>
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
    };
    if (initialData) {
      updateMutation.mutate({ id: initialData.id, data: payload }, { onSuccess });
    } else {
      createMutation.mutate({ data: { ...payload, organizationId: ORG_ID } }, { onSuccess });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4">
      <div className="space-y-2">
        <Label>Full Name</Label>
        <Input {...register("name")} placeholder="e.g. Erik Johansson" />
        {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Phone</Label>
          <Input {...register("phone")} placeholder="+46 70 123 4567" />
        </div>
        <div className="space-y-2">
          <Label>Email</Label>
          <Input {...register("email")} placeholder="erik@example.com" type="email" />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Assigned Vehicle</Label>
        <Controller
          name="vehicleId"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} defaultValue={field.value || "__none__"}>
              <SelectTrigger>
                <SelectValue placeholder="Select vehicle" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No vehicle</SelectItem>
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

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>Cancel</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? "Saving..." : "Save Driver"}
        </Button>
      </div>
    </form>
  );
}
