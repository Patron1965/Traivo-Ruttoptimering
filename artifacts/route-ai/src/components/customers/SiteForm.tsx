import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "react-i18next";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { Checkbox } from "@/components/ui/checkbox";
import { MapPin } from "lucide-react";

const siteSchema = z.object({
  name: z.string().min(1, "Name is required"),
  address: z.string().min(1, "Address is required"),
  contactName: z.string().optional().or(z.literal("")),
  contactPhone: z.string().optional().or(z.literal("")),
  contactEmail: z.string().email("Invalid email").optional().or(z.literal("")),
  windowStart: z.string().optional().or(z.literal("")),
  windowEnd: z.string().optional().or(z.literal("")),
  serviceDurationMin: z.coerce.number().min(1, "Duration must be at least 1 min"),
  instructions: z.string().optional().or(z.literal("")),
  verificationCandidateId: z.string().optional(),
  isPrioritized: z.boolean(),
});

export type SiteFormValues = z.infer<typeof siteSchema>;

export type SiteFormInitialData = {
  name?: string | null;
  address?: string | null;
  addressInput?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  serviceDurationMin?: number | null;
  instructions?: string | null;
  latitude?: number;
  longitude?: number;
  isPrioritized?: boolean | null;
};

interface SiteFormProps {
  initialData?: SiteFormInitialData;
  onSubmit: (data: SiteFormValues) => void | Promise<void>;
  isLoading?: boolean;
  onCancel: () => void;
  serverError?: { message: string, candidates?: any[] } | null;
}

export function SiteForm({ initialData, onSubmit, isLoading, onCancel, serverError }: SiteFormProps) {
  const { t } = useTranslation();
  const form = useForm<z.input<typeof siteSchema>, unknown, SiteFormValues>({
    resolver: zodResolver(siteSchema),
    defaultValues: {
      name: initialData?.name || "",
      address: initialData?.addressInput || initialData?.address || "",
      contactName: initialData?.contactName || "",
      contactPhone: initialData?.contactPhone || "",
      contactEmail: initialData?.contactEmail || "",
      windowStart: initialData?.windowStart || "",
      windowEnd: initialData?.windowEnd || "",
      serviceDurationMin: initialData?.serviceDurationMin ?? 15,
      instructions: initialData?.instructions || "",
      verificationCandidateId: "",
      isPrioritized: initialData?.isPrioritized === true,
    },
  });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" data-testid="site-form">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("customers.siteName", "Platsnamn")}</Label>
          <Input {...form.register("name")} placeholder="Huvudkontor, Lager 1..." />
          {form.formState.errors.name && (
            <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t("customers.address", "Adress")}</Label>
          <AddressAutocomplete
            value={form.watch("address")}
            onChange={(val) => {
              form.setValue("address", val, { shouldValidate: true });
              form.setValue("verificationCandidateId", "");
            }}
            onSuggestionSelect={(suggestion) => {
              form.setValue("verificationCandidateId", suggestion.id);
            }}
            persistedVerifiedAddress={
               initialData?.address && initialData.latitude !== undefined && initialData.longitude !== undefined
                ? { value: initialData.address, latitude: initialData.latitude, longitude: initialData.longitude }
                : undefined
            }
          />
          {form.formState.errors.address && (
            <p className="text-xs text-destructive">{form.formState.errors.address.message}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>{t("customers.contact", "Kontaktperson")}</Label>
          <Input {...form.register("contactName")} />
        </div>
        <div className="space-y-2">
          <Label>{t("customers.phone", "Telefon")}</Label>
          <Input type="tel" {...form.register("contactPhone")} />
        </div>
        <div className="space-y-2">
          <Label>{t("customers.email", "E-post")}</Label>
          <Input type="email" {...form.register("contactEmail")} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>{t("customers.windowStart", "Tidsfönster start")}</Label>
          <Input type="time" {...form.register("windowStart")} />
        </div>
        <div className="space-y-2">
          <Label>{t("customers.windowEnd", "Tidsfönster slut")}</Label>
          <Input type="time" {...form.register("windowEnd")} />
        </div>
        <div className="space-y-2">
          <Label>{t("customers.serviceDurationMin", "Servicetid (min)")}</Label>
          <Input type="number" min="1" {...form.register("serviceDurationMin")} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("customers.instructions", "Instruktioner")}</Label>
        <Textarea {...form.register("instructions")} rows={3} />
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-muted/30 p-3" data-testid="site-prioritized">
        <Checkbox
          checked={form.watch("isPrioritized")}
          onCheckedChange={(checked) => form.setValue("isPrioritized", checked === true, { shouldDirty: true })}
          className="mt-0.5"
          data-testid="checkbox-site-prioritized"
        />
        <span>
          <span className="block text-sm font-medium">{t("customers.prioritizedDefault")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("customers.prioritizedDefaultHint")}
          </span>
        </span>
      </label>

      {serverError && (
        <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
          <p className="font-medium">{serverError.message}</p>
          {serverError.candidates && serverError.candidates.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-muted-foreground">{t("customers.didYouMean", "Menade du:")}</p>
              <div className="flex flex-col gap-1">
                {serverError.candidates.map((c, i) => (
                  <Button 
                    key={i} 
                    type="button" 
                    variant="outline" 
                    size="sm" 
                    className="justify-start h-auto py-1.5 px-3 text-left"
                    onClick={() => {
                      form.setValue("address", c.address || c.displayName || c.value, { shouldValidate: true });
                      form.setValue("verificationCandidateId", c.id || c.verificationCandidateId);
                    }}
                  >
                    <MapPin className="h-3 w-3 mr-2 shrink-0 text-muted-foreground" />
                    <span className="truncate">{c.address || c.displayName || c.value}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
          {t("customers.cancel", "Avbryt")}
        </Button>
        <Button type="submit" disabled={isLoading}>
          {t("customers.save", "Spara")}
        </Button>
      </div>
    </form>
  );
}
