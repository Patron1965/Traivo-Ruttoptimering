import { AppLayout } from "@/components/layout/AppLayout";
import { useStops, useCreateStop, useUpdateStop, useDeleteStop } from "@/hooks/use-stops";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Edit2, MapPin } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ORG_ID } from "@/lib/constants";
import { type Stop } from "@workspace/api-client-react";

const stopSchema = z.object({
  address: z.string().min(1, "Address is required"),
  notes: z.string().optional(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  serviceDurationMin: z.coerce.number().min(1),
  weightKg: z.coerce.number().optional().nullable(),
  volumeM3: z.coerce.number().optional().nullable(),
  timeWindowStart: z.string().optional().nullable(),
  timeWindowEnd: z.string().optional().nullable(),
});

type StopFormValues = z.infer<typeof stopSchema>;

export default function Stops() {
  const { data: stops, isLoading } = useStops();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);

  const deleteMutation = useDeleteStop();

  if (isLoading) return <AppLayout><LoadingState message="Loading stops..." /></AppLayout>;

  return (
    <AppLayout>
      <div className="p-6 md:p-8 max-w-7xl mx-auto animate-in fade-in">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Delivery Stops</h1>
            <p className="text-muted-foreground mt-1">Manage unassigned and pending deliveries</p>
          </div>
          
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg hover:shadow-primary/25">
                <Plus className="h-4 w-4" /> Add Stop
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Add New Stop</DialogTitle>
              </DialogHeader>
              <StopForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card rounded-2xl border border-card-border overflow-hidden shadow-xl shadow-black/5">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Address</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Coordinates</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Time Window</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Requirements</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Status</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm text-right">Actions</th>
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
                          <p className="font-bold text-foreground">{stop.notes || "Delivery Stop"}</p>
                          <p className="text-sm text-muted-foreground mt-0.5 max-w-xs truncate" title={stop.address}>{stop.address}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-xs font-mono text-muted-foreground space-y-1">
                      <p>Lat: {stop.latitude.toFixed(4)}</p>
                      <p>Lng: {stop.longitude.toFixed(4)}</p>
                    </td>
                    <td className="p-4 text-xs text-muted-foreground space-y-1">
                      {stop.timeWindowStart ? (
                        <p>{new Date(stop.timeWindowStart).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</p>
                      ) : <p>-</p>}
                      {stop.timeWindowEnd ? (
                        <p>to {new Date(stop.timeWindowEnd).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</p>
                      ) : null}
                    </td>
                    <td className="p-4 text-sm space-y-1 text-muted-foreground">
                      <p>{stop.serviceDurationMin} mins</p>
                      {(stop.weightKg || stop.volumeM3) && (
                        <p>{stop.weightKg || 0}kg / {stop.volumeM3 || 0}m³</p>
                      )}
                    </td>
                    <td className="p-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
                        stop.routeId ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-500'
                      }`}>
                        {stop.routeId ? 'Assigned' : 'Unassigned'}
                      </span>
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
                            if(confirm("Delete this stop?")) deleteMutation.mutate({ id: stop.id });
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
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">No stops found. Add some deliveries to route.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Edit Modal */}
        <Dialog open={!!editingStop} onOpenChange={(open) => !open && setEditingStop(null)}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Edit Stop</DialogTitle>
            </DialogHeader>
            {editingStop && (
              <StopForm 
                initialData={editingStop} 
                onSuccess={() => setEditingStop(null)} 
              />
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

function StopForm({ initialData, onSuccess }: { initialData?: Stop, onSuccess: () => void }) {
  const createMutation = useCreateStop();
  const updateMutation = useUpdateStop();
  
  const { register, handleSubmit, formState: { errors } } = useForm<StopFormValues>({
    resolver: zodResolver(stopSchema),
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
        <Label>Notes</Label>
        <Input {...register("notes")} placeholder="Optional customer/delivery notes" />
      </div>

      <div className="space-y-2">
        <Label>Address</Label>
        <Input {...register("address")} placeholder="Full address" />
        {errors.address && <span className="text-xs text-destructive">{errors.address.message}</span>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Latitude</Label>
          <Input type="number" step="any" {...register("latitude")} />
        </div>
        <div className="space-y-2">
          <Label>Longitude</Label>
          <Input type="number" step="any" {...register("longitude")} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Service Duration (mins)</Label>
        <Input type="number" {...register("serviceDurationMin")} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Time Window Start</Label>
          <Input type="datetime-local" {...register("timeWindowStart")} />
        </div>
        <div className="space-y-2">
          <Label>Time Window End</Label>
          <Input type="datetime-local" {...register("timeWindowEnd")} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Weight (kg)</Label>
          <Input type="number" {...register("weightKg")} placeholder="Optional" />
        </div>
        <div className="space-y-2">
          <Label>Volume (m³)</Label>
          <Input type="number" {...register("volumeM3")} placeholder="Optional" />
        </div>
      </div>

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>Cancel</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? "Saving..." : "Save Stop"}
        </Button>
      </div>
    </form>
  );
}
