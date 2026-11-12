import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "react-i18next";
import type { Customer } from "@workspace/api-client-react";
import {
  CustomerUnavailablePeriodsEditor,
  type CustomerUnavailablePeriodErrors,
} from "./CustomerUnavailablePeriodsEditor";

const nullableText = (maxLength: number) => (
  z.string().max(maxLength, `Max ${maxLength} characters`).transform((value) => value.trim() || null)
);

const unavailablePeriodSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
}).superRefine((period, context) => {
  if (period.start >= period.end) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["end"],
      message: "End must be later than start; split overnight periods across weekdays.",
    });
  }
});

const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Max 200 characters"),
  email: z.union([
    z.string().email("Invalid email").max(320, "Max 320 characters"),
    z.literal(""),
  ]).transform((value) => value || null),
  phone: nullableText(100),
  address: nullableText(500),
  customerNumber: nullableText(100),
  organizationNumber: nullableText(100),
  contactName: nullableText(200),
  postalCode: nullableText(30),
  city: nullableText(100),
  country: nullableText(100),
  billingEmail: z.union([
    z.string().email("Invalid billing email").max(320, "Max 320 characters"),
    z.literal(""),
  ]).transform((value) => value || null),
  billingAddress: nullableText(500),
  notes: nullableText(2000),
  unavailablePeriods: z.array(unavailablePeriodSchema).max(100, "Max 100 periods"),
});

export type CustomerFormInput = z.input<typeof customerSchema>;
export type CustomerFormValues = z.output<typeof customerSchema>;

interface CustomerFormProps {
  initialData?: Customer;
  onSubmit: (data: CustomerFormValues) => void;
  isLoading?: boolean;
  onCancel: () => void;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

export function CustomerForm({ initialData, onSubmit, isLoading, onCancel }: CustomerFormProps) {
  const { t } = useTranslation();
  const form = useForm<CustomerFormInput, unknown, CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name: initialData?.name || "",
      email: initialData?.email || "",
      phone: initialData?.phone || "",
      address: initialData?.address || "",
      customerNumber: initialData?.customerNumber || "",
      organizationNumber: initialData?.organizationNumber || "",
      contactName: initialData?.contactName || "",
      postalCode: initialData?.postalCode || "",
      city: initialData?.city || "",
      country: initialData?.country || "",
      billingEmail: initialData?.billingEmail || "",
      billingAddress: initialData?.billingAddress || "",
      notes: initialData?.notes || "",
      unavailablePeriods: initialData?.unavailablePeriods || [],
    },
  });
  const unavailablePeriods = useFieldArray({
    control: form.control,
    name: "unavailablePeriods",
  });

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="max-h-[calc(100dvh-10rem)] space-y-6 overflow-y-auto pr-1"
    >
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("customers.basicInformation", "Grunduppgifter")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("customers.basicInformationDescription", "Namn och referenser som hjälper dig att hitta kunden.")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="customer-name">{t("customers.name", "Namn")}</Label>
            <Input id="customer-name" autoFocus {...form.register("name")} />
            <FieldError message={form.formState.errors.name?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-number">{t("customers.customerNumber", "Kundnummer")}</Label>
            <Input id="customer-number" maxLength={100} {...form.register("customerNumber")} />
            <FieldError message={form.formState.errors.customerNumber?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="organization-number">{t("customers.organizationNumber", "Organisationsnummer")}</Label>
            <Input id="organization-number" maxLength={100} {...form.register("organizationNumber")} />
            <FieldError message={form.formState.errors.organizationNumber?.message} />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t("customers.unavailablePeriods", "Spärrade mottagningstider")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "customers.unavailablePeriodsSummary",
              "Återkommande tider då kunden inte kan ta emot service. Separat från besöksplatsens positiva tidsfönster.",
            )}
          </p>
        </div>
        <CustomerUnavailablePeriodsEditor
          fields={unavailablePeriods.fields}
          register={form.register}
          append={unavailablePeriods.append}
          remove={unavailablePeriods.remove}
          errors={form.formState.errors.unavailablePeriods as CustomerUnavailablePeriodErrors | undefined}
        />
        {typeof form.formState.errors.unavailablePeriods?.message === "string" && (
          <FieldError message={form.formState.errors.unavailablePeriods.message} />
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("customers.contactInformation", "Kontaktuppgifter")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("customers.contactInformationDescription", "Den primära kontakten för kundens administration.")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="customer-email">{t("customers.email", "E-post")}</Label>
            <Input id="customer-email" type="email" maxLength={320} {...form.register("email")} />
            <FieldError message={form.formState.errors.email?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-phone">{t("customers.phone", "Telefon")}</Label>
            <Input id="customer-phone" type="tel" maxLength={100} {...form.register("phone")} />
            <FieldError message={form.formState.errors.phone?.message} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="customer-contact-name">{t("customers.contactName", "Kontaktperson")}</Label>
            <Input id="customer-contact-name" maxLength={200} {...form.register("contactName")} />
            <FieldError message={form.formState.errors.contactName?.message} />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("customers.customerAddress", "Kundadress")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "customers.customerAddressDescription",
              "Kundens administrativa adress. Den verifieras inte och används inte för navigering; lägg besöksplatser separat.",
            )}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="customer-address">{t("customers.address", "Adress")}</Label>
            <Input id="customer-address" maxLength={500} {...form.register("address")} />
            <FieldError message={form.formState.errors.address?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-postal-code">{t("customers.postalCode", "Postnummer")}</Label>
            <Input id="customer-postal-code" maxLength={30} {...form.register("postalCode")} />
            <FieldError message={form.formState.errors.postalCode?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-city">{t("customers.city", "Ort")}</Label>
            <Input id="customer-city" maxLength={100} {...form.register("city")} />
            <FieldError message={form.formState.errors.city?.message} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="customer-country">{t("customers.country", "Land")}</Label>
            <Input id="customer-country" maxLength={100} {...form.register("country")} />
            <FieldError message={form.formState.errors.country?.message} />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("customers.billingAndNotes", "Fakturering och privata anteckningar")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "customers.privateInformationDescription",
              "Den här informationen är endast för organisationen och skickas inte till förare, besöksinstruktioner eller publik spårning.",
            )}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="customer-billing-email">{t("customers.billingEmail", "Faktura-e-post")}</Label>
            <Input id="customer-billing-email" type="email" maxLength={320} {...form.register("billingEmail")} />
            <FieldError message={form.formState.errors.billingEmail?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-billing-address">{t("customers.billingAddress", "Fakturaadress")}</Label>
            <Input id="customer-billing-address" maxLength={500} {...form.register("billingAddress")} />
            <FieldError message={form.formState.errors.billingAddress?.message} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="customer-notes">{t("customers.notes", "Privata anteckningar")}</Label>
            <Textarea id="customer-notes" maxLength={2000} rows={4} {...form.register("notes")} />
            <FieldError message={form.formState.errors.notes?.message} />
          </div>
        </div>
      </section>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background pt-4">
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